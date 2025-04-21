import { BaseScanner, ScannerOptions } from "./base";
import { ScanResult } from "../../../types/common";
import { UrlProcessor } from "../utils/url";
import CrawlerRequestUtils from "../utils/request";

import {
  extractVisibleText,
  extractKeywords,
  extractMetadata,
} from "../processors/content";

/**
 * HTTP scanner that uses standard fetch requests
 */
export class HttpScanner extends BaseScanner {
  /**
   * Creates a new HTTP scanner
   * @param options Scanner options
   */
  constructor(options: ScannerOptions = {}) {
    super({
      ...options,
      userAgent: options.userAgent || CrawlerRequestUtils.getRotatedUserAgent(),
    });
  }

  /**
   * Scans a URL using standard HTTP requests
   * @param url URL to scan
   * @param depth Current crawl depth
   * @returns Scan result
   */
  async scan(url: string, depth: number): Promise<ScanResult> {
    const startTime = Date.now();
    const result = this.createBaseScanResult(url, depth);
    result.scan_method = "enhanced-http";

    try {
      const controller = new AbortController();

      let firstByteTime = 0;
      let responseReceived = false;

      // Perform the fetch request
      const response = await CrawlerRequestUtils.enhancedFetch(url, {
        userAgent: this.userAgent,
        additionalHeaders: {
          "X-Scan-Depth": depth.toString(),
          "X-Project-Url": url || "",
        },
      });

      // Record basic info
      result.status = response.status;
      result.content_type = response.headers.get("content-type") || "";
      result.redirected_from = response.url !== url ? url : undefined;
      result.url = response.url;
      result.is_redirect = response.url !== url;

      // Only process HTML content
      if (!result.content_type?.includes("text/html")) {
        // For JS files, try to extract URLs
        if (result.content_type?.includes("javascript")) {
          await this.processJavaScriptContent(
            result,
            await response.text(),
            url,
          );
        }

        result.load_time_ms = Date.now() - startTime;
        return result;
      }

      // Get content and size
      const html = await response.text();
      result.size_bytes = new TextEncoder().encode(html).length;

      // Process the HTML content
      await this.processHtmlContent(result, html, url);
    } catch (error) {
      result.status = 0;
      result.errors = [
        `Failed to fetch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }

    result.load_time_ms = Date.now() - startTime;
    return result;
  }

  /**
   * Processes HTML content
   * @param result Scan result to update
   * @param html HTML content
   * @param baseUrl Base URL for resolving relative URLs
   */
  private async processHtmlContent(
    result: ScanResult,
    html: string,
    baseUrl: string,
  ): Promise<void> {
    // Use DOMParser if available (browser environment)
    let doc: Document | null = null;

    try {
      if (typeof DOMParser !== "undefined") {
        const parser = new DOMParser();
        doc = parser.parseFromString(html, "text/html");
      }
    } catch (error) {
      result.warnings?.push("DOM parsing failed, using regex fallback");
    }

    if (doc) {
      // Extract metadata
      const metadata = extractMetadata(doc);
      result.title = metadata.title;
      result.meta_description = metadata.metaDescription;
      result.open_graph = metadata.openGraph;
      result.twitter_card = metadata.twitterCard;
      result.canonical_url = metadata.canonicalUrl;

      // Extract headings
      result.h1s = Array.from(doc.querySelectorAll("h1")).map(
        (el) => el.textContent?.trim() || "",
      );
      result.h2s = Array.from(doc.querySelectorAll("h2")).map(
        (el) => el.textContent?.trim() || "",
      );
      result.h3s = Array.from(doc.querySelectorAll("h3")).map(
        (el) => el.textContent?.trim() || "",
      );
      result.h4s = Array.from(doc.querySelectorAll("h4")).map(
        (el) => el.textContent?.trim() || "",
      );
      result.h5s = Array.from(doc.querySelectorAll("h5")).map(
        (el) => el.textContent?.trim() || "",
      );
      result.h6s = Array.from(doc.querySelectorAll("h6")).map(
        (el) => el.textContent?.trim() || "",
      );

      // Extract robots meta directives
      const robotsMeta =
        doc.querySelector('meta[name="robots"]')?.getAttribute("content") || "";
      result.has_robots_noindex = robotsMeta.toLowerCase().includes("noindex");
      result.has_robots_nofollow = robotsMeta
        .toLowerCase()
        .includes("nofollow");
      result.is_indexable = !result.has_robots_noindex;

      // Extract visible text and analyze
      const visibleText = extractVisibleText(doc);
      result.content_length = visibleText.length;
      result.word_count = visibleText
        .split(/\s+/)
        .filter((word) => word.length > 0).length;
      result.keywords = extractKeywords(visibleText);

      // Extract links
      this.extractLinks(result, doc, baseUrl);

      // Extract images
      this.extractImages(result, doc, baseUrl);

      // Count scripts and stylesheets
      result.js_count = doc.querySelectorAll("script[src]").length;
      result.css_count = doc.querySelectorAll('link[rel="stylesheet"]').length;

      // Extract structured data
      this.extractStructuredData(result, doc);
    } else {
      // Use regex fallback
      this.processWithRegex(result, html, baseUrl);
    }
  }

  /**
   * Extracts links from HTML document
   * @param result Scan result to update
   * @param doc HTML document
   * @param baseUrl Base URL for resolving relative URLs
   */
  private extractLinks(
    result: ScanResult,
    doc: Document,
    baseUrl: string,
  ): void {
    const urlProcessor = new UrlProcessor(baseUrl);
    const domain = urlProcessor.getDomain();

    const links = doc.querySelectorAll("a[href]");

    for (const link of Array.from(links)) {
      const href = link.getAttribute("href");

      if (!href || href === "#" || href.startsWith("javascript:")) {
        continue;
      }

      try {
        const resolvedUrl = urlProcessor.resolve(baseUrl, href);
        if (!resolvedUrl) continue;

        const anchorText = link.textContent?.trim() || "";
        const relAttr = link.getAttribute("rel") || "";
        const relAttributes = relAttr.split(/\s+/).filter(Boolean);

        if (urlProcessor.isInternal(resolvedUrl)) {
          result.internal_links.push({
            url: resolvedUrl,
            anchor_text: anchorText,
            rel_attributes: relAttributes,
          });
        } else {
          result.external_links.push({
            url: resolvedUrl,
            anchor_text: anchorText,
            rel_attributes: relAttributes,
          });
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  /**
   * Extracts images from HTML document
   * @param result Scan result to update
   * @param doc HTML document
   * @param baseUrl Base URL for resolving relative URLs
   */
  private extractImages(
    result: ScanResult,
    doc: Document,
    baseUrl: string,
  ): void {
    const urlProcessor = new UrlProcessor(baseUrl);

    const images = doc.querySelectorAll("img");

    for (const img of Array.from(images)) {
      const src = img.getAttribute("src");

      if (!src) {
        continue;
      }

      try {
        const resolvedUrl = urlProcessor.resolve(baseUrl, src);
        if (!resolvedUrl) continue;

        result.images.push({
          src: resolvedUrl,
          alt: img.getAttribute("alt") || "",
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  /**
   * Extracts structured data from HTML document
   * @param result Scan result to update
   * @param doc HTML document
   */
  private extractStructuredData(result: ScanResult, doc: Document): void {
    const jsonLdScripts = doc.querySelectorAll(
      'script[type="application/ld+json"]',
    );

    jsonLdScripts.forEach((script) => {
      try {
        const content = script.textContent || "";
        if (!content) return;

        const data = JSON.parse(content);
        result.structured_data.push(data);

        // Extract schema types
        if (data["@type"]) {
          const types = Array.isArray(data["@type"])
            ? data["@type"]
            : [data["@type"]];
          result.schema_types.push(...types);
        }
      } catch (error) {
        result.warnings?.push(
          `Failed to parse JSON-LD: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  /**
   * Processes JavaScript content to extract URLs
   * @param result Scan result to update
   * @param content JavaScript content
   * @param baseUrl Base URL for resolving relative URLs
   */
  private async processJavaScriptContent(
    result: ScanResult,
    content: string,
    baseUrl: string,
  ): Promise<void> {
    const urlProcessor = new UrlProcessor(baseUrl);

    // Extract URLs and paths from JavaScript
    const jsUrls = urlProcessor.extractUrlsFromJS(content);
    const jsPaths = urlProcessor.extractPathsFromJS(content);

    // Add extracted paths as internal links
    for (const path of jsPaths) {
      const fullUrl = urlProcessor.resolve(baseUrl, path);
      if (!fullUrl) continue;

      result.internal_links.push({
        url: fullUrl,
        anchor_text: `[JS Path: ${path}]`,
        rel_attributes: [],
      });
    }

    // Categorize JS URLs as internal or external
    for (const extractedUrl of jsUrls) {
      try {
        const fullUrl = urlProcessor.resolve(baseUrl, extractedUrl);
        if (!fullUrl) continue;

        if (urlProcessor.isInternal(fullUrl)) {
          result.internal_links.push({
            url: fullUrl,
            anchor_text: `[JS URL: ${extractedUrl}]`,
            rel_attributes: [],
          });
        } else {
          result.external_links.push({
            url: fullUrl,
            anchor_text: `[JS URL: ${extractedUrl}]`,
            rel_attributes: [],
          });
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  /**
   * Process HTML using regex when DOM parser is not available
   * @param result Scan result to update
   * @param html HTML content
   * @param baseUrl Base URL for resolving relative URLs
   */
  private processWithRegex(
    result: ScanResult,
    html: string,
    baseUrl: string,
  ): void {
    const urlProcessor = new UrlProcessor(baseUrl);

    // Extract title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      result.title = titleMatch[1].trim();
    }

    // Extract meta description
    const metaMatch =
      html.match(/<meta\s+name=["']description["']\s+content=["'](.*?)["']/i) ||
      html.match(/<meta\s+content=["'](.*?)["']\s+name=["']description["']/i);
    if (metaMatch && metaMatch[1]) {
      result.meta_description = metaMatch[1].trim();
    }

    // Extract robots meta
    const robotsMatch =
      html.match(/<meta\s+name=["']robots["']\s+content=["'](.*?)["']/i) ||
      html.match(/<meta\s+content=["'](.*?)["']\s+name=["']robots["']/i);
    if (robotsMatch && robotsMatch[1]) {
      const robotsContent = robotsMatch[1].toLowerCase();
      result.has_robots_noindex = robotsContent.includes("noindex");
      result.has_robots_nofollow = robotsContent.includes("nofollow");
      result.is_indexable = !result.has_robots_noindex;
    }

    // Extract h1
    const h1Regex = /<h1[^>]*>(.*?)<\/h1>/gi;
    let h1Match;
    while ((h1Match = h1Regex.exec(html)) !== null) {
      if (h1Match[1]) {
        result.h1s.push(h1Match[1].replace(/<[^>]+>/g, "").trim());
      }
    }

    // Extract links
    const linkRegex = /<a\s+[^>]*href=["'](.*?)["'][^>]*>(.*?)<\/a>/gi;
    let linkMatch;

    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const href = linkMatch[1];
      const text = linkMatch[2].replace(/<[^>]+>/g, "").trim();

      if (!href || href === "#" || href.startsWith("javascript:")) {
        continue;
      }

      try {
        const resolvedUrl = urlProcessor.resolve(baseUrl, href);
        if (!resolvedUrl) continue;

        if (urlProcessor.isInternal(resolvedUrl)) {
          result.internal_links.push({
            url: resolvedUrl,
            anchor_text: text,
            rel_attributes: [],
          });
        } else {
          result.external_links.push({
            url: resolvedUrl,
            anchor_text: text,
            rel_attributes: [],
          });
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }

    // Extract images
    const imgRegex = /<img\s+[^>]*src=["'](.*?)["'][^>]*>/gi;
    let imgMatch;

    while ((imgMatch = imgRegex.exec(html)) !== null) {
      const src = imgMatch[1];

      if (!src) {
        continue;
      }

      try {
        const resolvedUrl = urlProcessor.resolve(baseUrl, src);
        if (!resolvedUrl) continue;

        // Try to extract alt text
        const altMatch = imgMatch[0].match(/alt=["'](.*?)["']/i);
        const alt = altMatch ? altMatch[1] : "";

        result.images.push({
          src: resolvedUrl,
          alt,
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }

    // Extract content and analyze
    const visibleText = extractVisibleText(html);
    result.content_length = visibleText.length;
    result.word_count = visibleText
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
    result.keywords = extractKeywords(visibleText);

    // Count scripts and styles
    let jsCount = 0;
    let cssCount = 0;

    const scriptRegex = /<script\s+[^>]*src=["'](.*?)["'][^>]*>/gi;
    while (scriptRegex.exec(html) !== null) {
      jsCount++;
    }

    const styleRegex = /<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi;
    while (styleRegex.exec(html) !== null) {
      cssCount++;
    }

    result.js_count = jsCount;
    result.css_count = cssCount;
  }
}
