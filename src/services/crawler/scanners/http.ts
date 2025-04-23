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

        // If no anchor text was found, use relative URL or path
        if (!anchorText) {
          // For relative URLs, show the path part
          const urlParts = new URL(resolvedUrl);
          anchorText =
            processedHref.startsWith("/") ||
            processedHref.startsWith("./") ||
            processedHref.startsWith("../")
              ? processedHref
              : urlParts.pathname || resolvedUrl;

          // Trim to reasonable length if needed
          if (anchorText.length > 50) {
            anchorText = anchorText.substring(0, 47) + "...";
          }
        }

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
    // Try to get direct text content if available and not just whitespace
    const directText = linkElement.textContent?.trim() || "";

    // Check if there's actual text content (not just whitespace from nested elements)
    if (directText && directText.length > 1) {
      return directText;
    }

    // First priority: Look specifically for textPath elements within SVGs
    // These are common in fancy UI buttons and circular text elements
    const textPaths = linkElement.querySelectorAll("textPath");
    if (textPaths.length > 0) {
      const textPathContent = Array.from(textPaths)
        .map((textPath) => textPath.textContent?.trim())
        .filter(Boolean)
        .join(" ");

      if (textPathContent) {
        return textPathContent;
      }
    }

    // Second priority: Look for any text nodes directly in the element or its children
    // This does a more thorough traversal than just textContent
    const textNodes = this.getAllTextNodes(linkElement);
    if (textNodes.length > 0) {
      const textNodeContent = textNodes
        .map((node) => node.textContent?.trim())
        .filter((text) => text && text.length > 0)
        .join(" ");

      if (textNodeContent) {
        return textNodeContent;
      }
    }

    // Third priority: Check for image alt text
    const images = linkElement.querySelectorAll("img[alt]");
    if (images.length > 0) {
      const altTexts = Array.from(images)
        .map((img) => img.getAttribute("alt")?.trim())
        .filter(Boolean)
        .join(" ");

      if (altTexts) {
        return `[Image: ${altTexts}]`;
      }
    }

    // Fourth priority: Check for accessibility attributes
    const ariaLabel = linkElement.getAttribute("aria-label")?.trim();
    if (ariaLabel) {
      return ariaLabel;
    }

    // Fifth priority: Check for title attribute
    const title = linkElement.getAttribute("title")?.trim();
    if (title) {
      return title;
    }

    // Last resort: Return null instead of placeholder
    return ""; // Return empty string to indicate no text was found
  }

  /**
   * Recursively gets all text nodes within an element
   * @param element Element to search within
   * @returns Array of text nodes
   */
  private getAllTextNodes(element: Element): Text[] {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
    );

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node && node.textContent && node.textContent.trim()) {
        textNodes.push(node);
      }
    }

    return textNodes;
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

    // Try to find textPath content for SVG-based links
    const textPathContents = new Map<string, string>();

    // Extract textPath content
    const textPathRegex = /<textPath[^>]*>(.*?)<\/textPath>/gi;
    let textPathMatch;
    while ((textPathMatch = textPathRegex.exec(html)) !== null) {
      if (textPathMatch[1]) {
        // Try to associate with the closest parent <a> tag
        // This is a simplification, but can help in many cases
        const textContent = textPathMatch[1].replace(/<[^>]+>/g, "").trim();

        // Find position of this textPath in the document
        const position = textPathMatch.index;

        // Store for later use when processing links
        textPathContents.set(position.toString(), textContent);
      }
    }

    // Extract links with improved regex to capture more complex cases
    const linkRegex = /<a\s+[^>]*href=["']([^"'<>]+)["'][^>]*>/gi;
    let linkMatch;

    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const href = linkMatch[1];
      const linkStartPosition = linkMatch.index;

      // Skip javascript and empty links
      if (!href || href === "#" || href.startsWith("javascript:")) {
        continue;
      }

      try {
        const resolvedUrl = urlProcessor.resolve(baseUrl, href);
        if (!resolvedUrl) continue;

        // Try to extract text content
        let text = "";

        // Look for closing </a> tag
        const linkContent = html.substring(linkStartPosition);
        const closeTagMatch = /<\/a>/i.exec(linkContent);

        if (closeTagMatch) {
          // Extract content between opening and closing tags
          const contentEndIndex = closeTagMatch.index;
          const linkContentHtml = linkContent.substring(0, contentEndIndex);

          // Remove HTML tags to get plain text
          text = linkContentHtml
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          // If no text content, check if there's a textPath near this link
          if (!text) {
            // Find the closest textPath content
            let closestDistance = Infinity;
            let closestTextPathContent = "";

            for (const [
              positionStr,
              textPathContent,
            ] of textPathContents.entries()) {
              const textPathPosition = parseInt(positionStr);
              const distance = Math.abs(textPathPosition - linkStartPosition);

              // If this textPath is inside the link's content area
              if (
                distance < closestDistance &&
                textPathPosition > linkStartPosition &&
                textPathPosition < linkStartPosition + contentEndIndex
              ) {
                closestDistance = distance;
                closestTextPathContent = textPathContent;
              }
            }

            if (closestTextPathContent) {
              text = closestTextPathContent;
            }
          }

          // If still no text, check for aria-label or title
          if (!text) {
            const ariaLabelMatch = linkMatch[0].match(
              /aria-label=["'](.*?)["']/i,
            );
            if (ariaLabelMatch && ariaLabelMatch[1]) {
              text = ariaLabelMatch[1];
            } else {
              const titleMatch = linkMatch[0].match(/title=["'](.*?)["']/i);
              if (titleMatch && titleMatch[1]) {
                text = titleMatch[1];
              }
            }
          }
        }

        // If still no text was found, use the path part of the URL
        if (!text) {
          if (
            href.startsWith("/") ||
            href.startsWith("./") ||
            href.startsWith("../")
          ) {
            text = href;
          } else {
            try {
              const urlParts = new URL(resolvedUrl);
              text = urlParts.pathname || resolvedUrl;
            } catch (e) {
              text = href;
            }
          }
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

  // Add this to your HttpScanner class

  /**
   * Determines if the scan result looks suspicious and needs headless verification
   * @param result The scan result to evaluate
   * @returns Boolean indicating if result needs verification
   */
  public needsHeadlessVerification(result: ScanResult): boolean {
    // List of suspicious conditions
    const suspiciousConditions = [
      // Payment provider as title
      this.isPaymentProviderTitle(result.title || ""),

      // Missing or very short title (likely not fully loaded)
      !result.title || result.title.length < 3,

      // Missing expected content on an HTML page
      result.content_type?.includes("text/html") &&
        result.content_length < 1000,

      // No headings on what should be a content page
      result.content_type?.includes("text/html") &&
        result.h1s.length === 0 &&
        result.h2s.length === 0 &&
        new URL(result.url).pathname !== "/",

      // No internal links on what should be a navigation page
      result.content_type?.includes("text/html") &&
        result.internal_links.length === 0 &&
        new URL(result.url).pathname !== "/404" &&
        !result.url.includes("login") &&
        !result.url.includes("signin"),
    ];

    // Return true if any condition is met
    return suspiciousConditions.some((condition) => condition);
  }

  /**
   * Checks if title appears to be a payment provider name
   * @param title The page title
   * @returns Boolean indicating if title is a payment provider
   */
  public isPaymentProviderTitle(title: string): boolean {
    if (!title) return false;

    const paymentProviders = [
      "American Express",
      "Visa",
      "MasterCard",
      "PayPal",
      "Apple Pay",
      "Google Pay",
      "Stripe",
      "Shop Pay",
      "Checkout",
    ];

    return paymentProviders.includes(title.trim());
  }
}
