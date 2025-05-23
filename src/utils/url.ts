export class UrlProcessor {
  private baseUrl: string;
  private baseDomain: string;

  constructor(baseUrl: string) {
    this.baseUrl = this.normalize(baseUrl);
    try {
      const url = new URL(this.baseUrl);
      this.baseDomain = url.hostname.toLowerCase();
    } catch (error) {
      throw new Error(`Invalid base URL: ${baseUrl}`);
    }
  }

  /**
   * Normalize a URL by cleaning it up and ensuring consistent format
   */
  normalize(url: string): string {
    if (!url || typeof url !== "string") {
      throw new Error("URL must be a non-empty string");
    }

    try {
      // Handle relative URLs by resolving against base URL if available
      let normalizedUrl: string;

      if (url.startsWith("//")) {
        // Protocol-relative URL
        const baseProtocol = new URL(this.baseUrl).protocol;
        normalizedUrl = `${baseProtocol}${url}`;
      } else if (url.startsWith("/")) {
        // Absolute path
        const baseUrlObj = new URL(this.baseUrl);
        normalizedUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${url}`;
      } else if (!url.includes("://")) {
        // Relative path or missing protocol
        if (url.includes(".") && !url.includes("/")) {
          // Likely a domain without protocol
          normalizedUrl = `https://${url}`;
        } else {
          // Relative path
          normalizedUrl = new URL(url, this.baseUrl).href;
        }
      } else {
        normalizedUrl = url;
      }

      const urlObj = new URL(normalizedUrl);

      // IMPORTANT: Normalize www vs non-www to match base domain preference
      const baseDomainObj = new URL(this.baseUrl);
      const baseHasWww = baseDomainObj.hostname.startsWith("www.");
      const urlHasWww = urlObj.hostname.startsWith("www.");

      // If base domain has www but URL doesn't, add www
      if (
        baseHasWww &&
        !urlHasWww &&
        this.isSameDomain(urlObj.hostname, baseDomainObj.hostname)
      ) {
        urlObj.hostname = `www.${urlObj.hostname}`;
      }
      // If base domain doesn't have www but URL does, remove www
      else if (
        !baseHasWww &&
        urlHasWww &&
        this.isSameDomain(urlObj.hostname, baseDomainObj.hostname)
      ) {
        urlObj.hostname = urlObj.hostname.replace(/^www\./, "");
      }

      // Clean up the URL
      urlObj.hash = ""; // Remove fragments

      // Remove common tracking parameters
      const trackingParams = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "fbclid",
        "gclid",
        "msclkid",
        "ref",
        "_ga",
        "mc_cid",
        "mc_eid",
      ];

      trackingParams.forEach((param) => {
        urlObj.searchParams.delete(param);
      });

      // Clean up trailing slash consistency
      if (urlObj.pathname.endsWith("/") && urlObj.pathname.length > 1) {
        urlObj.pathname = urlObj.pathname.slice(0, -1);
      }

      // Ensure consistent protocol (prefer https)
      if (urlObj.protocol === "http:" && this.supportsHttps(urlObj.hostname)) {
        urlObj.protocol = "https:";
      }

      return urlObj.toString();
    } catch (error) {
      throw new Error(
        `Failed to normalize URL "${url}": ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  /**
   * Check if two domains are the same (ignoring www)
   */
  private isSameDomain(domain1: string, domain2: string): boolean {
    const clean1 = domain1.replace(/^www\./, "").toLowerCase();
    const clean2 = domain2.replace(/^www\./, "").toLowerCase();
    return clean1 === clean2;
  }

  /**
   * Check if a URL is internal (same domain as base URL)
   */
  isInternal(url: string): boolean {
    try {
      const urlObj = new URL(url);
      const urlDomain = urlObj.hostname.toLowerCase();

      // Exact match
      if (urlDomain === this.baseDomain) {
        return true;
      }

      // Check for subdomain relationship
      if (
        urlDomain.endsWith(`.${this.baseDomain}`) ||
        this.baseDomain.endsWith(`.${urlDomain}`)
      ) {
        return true;
      }

      // Handle www variations
      const baseWithoutWww = this.baseDomain.replace(/^www\./, "");
      const urlWithoutWww = urlDomain.replace(/^www\./, "");

      return baseWithoutWww === urlWithoutWww;
    } catch (error) {
      return false;
    }
  }

  /**
   * Resolve a relative URL against a base URL
   */
  resolve(baseUrl: string, relativeUrl: string): string | null {
    try {
      const resolved = new URL(relativeUrl, baseUrl);
      return this.normalize(resolved.href);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get the base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get the base domain
   */
  getBaseDomain(): string {
    return this.baseDomain;
  }

  /**
   * Check if a URL should be excluded from crawling
   */
  shouldExclude(url: string, excludePatterns: RegExp[] = []): boolean {
    // Default exclusion patterns
    const defaultExclusions = [
      /\.(jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff)$/i, // Images
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|tar|gz)$/i, // Documents
      /\.(mp3|mp4|avi|mov|wmv|flv|wav|ogg)$/i, // Media files
      /\/(wp-admin|wp-includes|wp-content\/plugins)\//i, // WordPress admin
      /\/admin\//i, // General admin paths
      /\/ajax\//i, // AJAX endpoints
      /\/api\//i, // API endpoints (unless specifically needed)
      /\?.*search/i, // Search results
      /\?.*filter/i, // Filter pages
      /\?.*sort/i, // Sort pages
      /login|logout|register|signin|signup/i, // Auth pages
      /privacy-policy|terms|cookie-policy/i, // Legal pages
      /contact|about\/team/i, // Non-product pages that rarely change
    ];

    const allPatterns = [...defaultExclusions, ...excludePatterns];

    return allPatterns.some((pattern) => pattern.test(url));
  }

  /**
   * Extract the path depth of a URL
   */
  getPathDepth(url: string): number {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname
        .split("/")
        .filter((part) => part.length > 0);
      return pathParts.length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Check if URL is likely a product page (for e-commerce sites)
   */
  isLikelyProductPage(url: string): boolean {
    const productIndicators = [
      /\/products?\//i,
      /\/item\//i,
      /\/shop\//i,
      /\/store\//i,
      /\/catalog\//i,
      /\/buy\//i,
      /\/p\//i,
      /\/product-/i,
      /\/sku-/i,
    ];

    return productIndicators.some((pattern) => pattern.test(url));
  }

  /**
   * Check if URL is likely a category/collection page
   */
  isLikelyCategoryPage(url: string): boolean {
    const categoryIndicators = [
      /\/categories?\//i,
      /\/collections?\//i,
      /\/browse\//i,
      /\/section\//i,
      /\/department\//i,
      /\/catalog\//i,
      /\/shop$/i,
      /\/store$/i,
    ];

    return categoryIndicators.some((pattern) => pattern.test(url));
  }

  /**
   * Get URL priority for crawling (higher = more important)
   */
  getCrawlPriority(url: string, depth: number): number {
    let priority = 10 - depth; // Base priority decreases with depth

    // Boost priority for important page types
    if (this.isLikelyProductPage(url)) {
      priority += 5;
    } else if (this.isLikelyCategoryPage(url)) {
      priority += 3;
    }

    // Boost priority for shorter URLs (often more important)
    const pathDepth = this.getPathDepth(url);
    if (pathDepth <= 1) {
      priority += 2;
    }

    // Reduce priority for pages with many query parameters
    try {
      const urlObj = new URL(url);
      const paramCount = Array.from(urlObj.searchParams.keys()).length;
      if (paramCount > 3) {
        priority -= 2;
      }
    } catch (error) {
      // Ignore error
    }

    return Math.max(1, priority);
  }

  /**
   * Basic check if domain supports HTTPS
   */
  private supportsHttps(hostname: string): boolean {
    // Common domains that support HTTPS
    const httpsSupported = [
      "shopify.com",
      "myshopify.com",
      "squarespace.com",
      "wix.com",
      "webflow.io",
      "wordpress.com",
      "github.io",
      "netlify.app",
      "vercel.app",
    ];

    return httpsSupported.some((domain) => hostname.includes(domain));
  }

  /**
   * Clean and validate a URL before processing
   */
  validateAndClean(url: string): string | null {
    try {
      // Basic validation
      if (!url || typeof url !== "string" || url.trim().length === 0) {
        return null;
      }

      const trimmed = url.trim();

      // Skip invalid protocols
      if (
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:") ||
        trimmed.startsWith("data:") ||
        trimmed === "#"
      ) {
        return null;
      }

      // Skip very long URLs (likely spam or malformed)
      if (trimmed.length > 2000) {
        return null;
      }

      return this.normalize(trimmed);
    } catch (error) {
      return null;
    }
  }
}
