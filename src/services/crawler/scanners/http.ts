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

    // Get all link elements
    const links = doc.querySelectorAll("a[href]");

    for (const link of Array.from(links)) {
      const href = link.getAttribute("href")?.trim();
      if (!href || href === "#" || href.startsWith("javascript:")) {
        continue;
      }

      // Sanitize URLs that contain HTML-like content
      let processedHref = href;
      if (href.includes(">") || href.includes("<")) {
        console.warn(`Potentially malformed URL found: ${href}`);
        processedHref = href.split(/[<>]/)[0];
        if (!processedHref) continue;
      }

      try {
        // Use the sanitized URL for resolution
        const resolvedUrl = urlProcessor.resolve(baseUrl, processedHref);
        if (!resolvedUrl) continue;

        // Extract anchor text with improved handling for complex content
        let anchorText = this.extractAnchorText(link);

        // Get rel attributes
        const relAttr = link.getAttribute("rel") || "";
        const relAttributes = relAttr.split(/\s+/).filter(Boolean);

        // Add debug info
        console.log(
          `Found link: ${resolvedUrl} with text: ${anchorText || "(empty)"}`,
        );

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
        console.warn(`Error processing URL ${href}:`, error);
      }
    }

    // Also capture links from onclick handlers and other attributes
    this.extractNonStandardLinks(result, doc, baseUrl);
  }

  /**
   * Extracts anchor text from a link element with improved handling for complex content
   * @param linkElement Link element
   * @returns Extracted anchor text
   */
  private extractAnchorText(linkElement: Element): string {
    // First, try to get direct text content if available
    let text = linkElement.textContent?.trim() || "";

    // If text is empty, check for specific child elements that might contain text
    if (!text) {
      // Check for SVG textPath elements (common in fancy UI elements)
      const textPaths = linkElement.querySelectorAll("textPath");
      if (textPaths.length > 0) {
        const textPathContent = Array.from(textPaths)
          .map((textPath) => textPath.textContent?.trim())
          .filter(Boolean)
          .join(" ");

        if (textPathContent) {
          text = textPathContent;
        }
      }

      // Check for image alt text if no other text was found
      if (!text) {
        const images = linkElement.querySelectorAll("img[alt]");
        if (images.length > 0) {
          const altTexts = Array.from(images)
            .map((img) => img.getAttribute("alt")?.trim())
            .filter(Boolean)
            .join(" ");

          if (altTexts) {
            text = `[Image: ${altTexts}]`;
          }
        }
      }

      // Check for aria-label on the link element itself
      if (!text) {
        const ariaLabel = linkElement.getAttribute("aria-label")?.trim();
        if (ariaLabel) {
          text = ariaLabel;
        }
      }

      // If still no text, check for title attribute
      if (!text) {
        const title = linkElement.getAttribute("title")?.trim();
        if (title) {
          text = title;
        }
      }

      // If still no text, use a placeholder based on the link's destination
      if (!text) {
        const href = linkElement.getAttribute("href")?.trim() || "";
        text = `[Link to: ${href}]`;
      }
    }

    return text;
  }

  /**
   * Extracts links from non-standard sources like onclick handlers
   * @param result Scan result to update
   * @param doc HTML document
   * @param baseUrl Base URL for resolving relative URLs
   */
  private extractNonStandardLinks(
    result: ScanResult,
    doc: Document,
    baseUrl: string,
  ): void {
    const urlProcessor = new UrlProcessor(baseUrl);

    // Elements that might contain links in JavaScript handlers
    const elementsWithHandlers = doc.querySelectorAll("[onclick], [data-href]");

    for (const element of Array.from(elementsWithHandlers)) {
      // Check onclick attribute
      const onclickAttr = element.getAttribute("onclick");
      if (onclickAttr) {
        // Extract URLs or paths from the onclick handler
        const urlMatches = onclickAttr.match(
          /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/,
        );
        if (urlMatches && urlMatches[1]) {
          try {
            const extractedUrl = urlMatches[1];
            const resolvedUrl = urlProcessor.resolve(baseUrl, extractedUrl);

            if (resolvedUrl) {
              const isInternal = urlProcessor.isInternal(resolvedUrl);
              const linkInfo = {
                url: resolvedUrl,
                anchor_text: `[JS Link: ${
                  element.textContent?.trim() || extractedUrl
                }]`,
                rel_attributes: [],
              };

              if (isInternal) {
                result.internal_links.push(linkInfo);
              } else {
                result.external_links.push(linkInfo);
              }
            }
          } catch (error) {
            // Skip invalid URLs
          }
        }
      }

      // Check data-href attribute (common in custom frameworks)
      const dataHref = element.getAttribute("data-href");
      if (dataHref) {
        try {
          const resolvedUrl = urlProcessor.resolve(baseUrl, dataHref);

          if (resolvedUrl) {
            const isInternal = urlProcessor.isInternal(resolvedUrl);
            const linkInfo = {
              url: resolvedUrl,
              anchor_text: `[Data Link: ${
                element.textContent?.trim() || dataHref
              }]`,
              rel_attributes: [],
            };

            if (isInternal) {
              result.internal_links.push(linkInfo);
            } else {
              result.external_links.push(linkInfo);
            }
          }
        } catch (error) {
          // Skip invalid URLs
        }
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

    // Extract links with improved regex to capture more complex cases
    const linkRegex =
      /<a\s+[^>]*href=["']([^"'<>]+)["'][^>]*(?:>\s*(.*?)\s*<\/a>|\/?>)/gi;
    let linkMatch;

    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const href = linkMatch[1];
      // Content might be empty for self-closing tags or complex nested content
      let text = linkMatch[2]
        ? linkMatch[2].replace(/<[^>]+>/g, "").trim()
        : "";

      // Skip javascript and empty links
      if (!href || href === "#" || href.startsWith("javascript:")) {
        continue;
      }

      try {
        const resolvedUrl = urlProcessor.resolve(baseUrl, href);
        if (!resolvedUrl) continue;

        // If no text was found, use the URL as the text
        if (!text) {
          text = `[Link to: ${href}]`;
        }

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
