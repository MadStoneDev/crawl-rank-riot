import { promises as dns } from "dns";
import { isIPv4, isIPv6 } from "net";

/**
 * Check if an IP address belongs to a private/reserved range.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 private/reserved ranges
  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    return false;
  }

  // IPv6 private/reserved ranges
  if (isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // ::1 (loopback)
    if (normalized === "::1") return true;
    // fc00::/7 (unique local)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    // fe80::/10 (link-local)
    if (normalized.startsWith("fe80")) return true;
    // :: (unspecified)
    if (normalized === "::") return true;
    return false;
  }

  return false;
}

/**
 * Validate that a URL resolves to a public IP address (SSRF protection).
 * Returns true if the URL is safe to fetch, false if it resolves to a
 * private/reserved IP range.
 */
export async function isPublicUrl(url: string): Promise<boolean> {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // If the hostname is already an IP address, check it directly
    if (isIPv4(hostname) || isIPv6(hostname)) {
      return !isPrivateIP(hostname);
    }

    // Resolve DNS and check all returned addresses
    const addresses = await dns.resolve(hostname);
    if (!addresses || addresses.length === 0) {
      return false;
    }

    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return false;
      }
    }

    return true;
  } catch {
    // DNS resolution failure -- block by default
    return false;
  }
}

/** Protocols that should never be treated as crawlable pages */
const NON_HTTP_PROTOCOLS = [
  "mailto:",
  "tel:",
  "javascript:",
  "data:",
  "ftp:",
  "ftps:",
  "blob:",
  "file:",
  "sms:",
  "geo:",
  "whatsapp:",
  "skype:",
  "viber:",
  "callto:",
];

function isNonHttpUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return NON_HTTP_PROTOCOLS.some((p) => lower.startsWith(p));
}

export class UrlProcessor {
  private baseUrl: string;
  private baseDomain: string;
  private preferredWwwFormat: "www" | "non-www" | "unknown" = "unknown";

  constructor(baseUrl: string) {
    this.baseUrl = this.normalizeBasic(baseUrl);
    try {
      const url = new URL(this.baseUrl);
      this.baseDomain = url.hostname.toLowerCase();
    } catch (error) {
      throw new Error(`Invalid base URL: ${baseUrl}`);
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
   * Basic normalization without www preference (used for constructor)
   */
  private normalizeBasic(url: string): string {
    if (!url || typeof url !== "string") {
      throw new Error("URL must be a non-empty string");
    }

    if (!url.includes("://")) {
      url = `https://${url}`;
    }

    const urlObj = new URL(url);
    urlObj.hash = "";

    if (urlObj.pathname.endsWith("/") && urlObj.pathname.length > 1) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }

    return urlObj.toString();
  }

  /**
   * Detect the preferred www format by checking redirects and analyzing links
   */
  async detectPreferredWwwFormat(
    scanResults?: Array<{ internal_links: Array<{ url: string }> }>,
  ): Promise<void> {
    console.log("🔍 Detecting preferred www format...");

    // Method 1: Check redirect behavior
    const wwwPreference = await this.checkRedirectPreference();

    if (wwwPreference !== "unknown") {
      this.preferredWwwFormat = wwwPreference;
      console.log(
        `✅ Detected preferred format via redirects: ${wwwPreference}`,
      );
      return;
    }

    // Method 2: Analyze internal links patterns (if scan results provided)
    if (scanResults && scanResults.length > 0) {
      const linkPreference = this.analyzeInternalLinkPatterns(scanResults);
      if (linkPreference !== "unknown") {
        this.preferredWwwFormat = linkPreference;
        console.log(
          `✅ Detected preferred format via link analysis: ${linkPreference}`,
        );
        return;
      }
    }

    // Method 3: Default to current base URL format
    const baseUrlObj = new URL(this.baseUrl);
    this.preferredWwwFormat = baseUrlObj.hostname.startsWith("www.")
      ? "www"
      : "non-www";
    console.log(
      `⚠️ Using base URL format as fallback: ${this.preferredWwwFormat}`,
    );
  }

  /**
   * Check redirect behavior to determine www preference
   */
  private async checkRedirectPreference(): Promise<
    "www" | "non-www" | "unknown"
  > {
    try {
      const baseUrlObj = new URL(this.baseUrl);
      const baseDomainWithoutWww = baseUrlObj.hostname.replace(/^www\./, "");

      // Test both www and non-www versions
      const wwwUrl = `${baseUrlObj.protocol}//www.${baseDomainWithoutWww}${baseUrlObj.pathname}`;
      const nonWwwUrl = `${baseUrlObj.protocol}//${baseDomainWithoutWww}${baseUrlObj.pathname}`;

      const results = await Promise.allSettled([
        this.testUrlRedirect(wwwUrl),
        this.testUrlRedirect(nonWwwUrl),
      ]);

      const wwwResult =
        results[0].status === "fulfilled" ? results[0].value : null;
      const nonWwwResult =
        results[1].status === "fulfilled" ? results[1].value : null;

      // Analyze redirect patterns
      if (wwwResult && nonWwwResult) {
        // If www redirects to non-www, prefer non-www
        if (
          wwwResult.finalUrl.includes(`//${baseDomainWithoutWww}`) &&
          !wwwResult.finalUrl.includes("//www.")
        ) {
          return "non-www";
        }

        // If non-www redirects to www, prefer www
        if (nonWwwResult.finalUrl.includes(`//www.${baseDomainWithoutWww}`)) {
          return "www";
        }

        // If both work without redirects, check which has better response
        if (
          wwwResult.redirected === false &&
          nonWwwResult.redirected === false
        ) {
          // Both work, check status codes
          if (wwwResult.status === 200 && nonWwwResult.status !== 200) {
            return "www";
          } else if (nonWwwResult.status === 200 && wwwResult.status !== 200) {
            return "non-www";
          }
        }
      }

      return "unknown";
    } catch (error) {
      console.log("⚠️ Could not detect www preference via redirects:", error);
      return "unknown";
    }
  }

  /**
   * Test URL redirect behavior
   */
  private async testUrlRedirect(url: string): Promise<{
    finalUrl: string;
    status: number;
    redirected: boolean;
  }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: "HEAD", // Use HEAD to avoid downloading content
        redirect: "follow",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      return {
        finalUrl: response.url,
        status: response.status,
        redirected: response.url !== url,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Analyze internal link patterns to detect www preference
   */
  private analyzeInternalLinkPatterns(
    scanResults: Array<{ internal_links: Array<{ url: string }> }>,
  ): "www" | "non-www" | "unknown" {
    let wwwCount = 0;
    let nonWwwCount = 0;
    const baseDomainWithoutWww = this.baseDomain.replace(/^www\./, "");

    for (const result of scanResults) {
      for (const link of result.internal_links) {
        try {
          const linkUrl = new URL(link.url);
          const linkDomain = linkUrl.hostname.toLowerCase();

          // Only count links to the same base domain
          if (
            linkDomain === `www.${baseDomainWithoutWww}` ||
            linkDomain === baseDomainWithoutWww
          ) {
            if (linkDomain.startsWith("www.")) {
              wwwCount++;
            } else {
              nonWwwCount++;
            }
          }
        } catch (error) {
          // Skip invalid URLs
        }
      }
    }

    console.log(
      `📊 Link analysis: ${wwwCount} www links, ${nonWwwCount} non-www links`,
    );

    const totalLinks = wwwCount + nonWwwCount;
    if (totalLinks < 5) {
      return "unknown"; // Not enough data
    }

    // If 70% or more links use one format, that's the preference
    const wwwPercentage = wwwCount / totalLinks;
    if (wwwPercentage >= 0.7) {
      return "www";
    } else if (wwwPercentage <= 0.3) {
      return "non-www";
    }

    return "unknown"; // Mixed usage
  }

  /**
   * Normalize a URL by cleaning it up and ensuring consistent format
   */
  normalize(url: string): string {
    if (!url || typeof url !== "string") {
      throw new Error("URL must be a non-empty string");
    }

    try {
      // Reject non-HTTP protocols early (mailto:, tel:, etc.)
      if (isNonHttpUrl(url)) {
        throw new Error(`Non-HTTP protocol: ${url}`);
      }

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

      // Reject URLs with credentials — no legitimate crawlable page has
      // username:password in the URL. This also catches the pattern where
      // "mailto:hello@domain" gets parsed as username=mailto, password=hello.
      if (urlObj.username || urlObj.password) {
        throw new Error(`URL contains credentials: ${url}`);
      }

      // Apply www preference if detected and this is the same domain
      if (
        this.preferredWwwFormat !== "unknown" &&
        this.isSameDomain(urlObj.hostname, this.baseDomain)
      ) {
        const domainWithoutWww = urlObj.hostname.replace(/^www\./, "");

        if (
          this.preferredWwwFormat === "www" &&
          !urlObj.hostname.startsWith("www.")
        ) {
          urlObj.hostname = `www.${domainWithoutWww}`;
        } else if (
          this.preferredWwwFormat === "non-www" &&
          urlObj.hostname.startsWith("www.")
        ) {
          urlObj.hostname = domainWithoutWww;
        }
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
      if (urlObj.protocol === "http:") {
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
      // Reject non-HTTP protocols before resolving
      if (isNonHttpUrl(relativeUrl)) return null;

      const resolved = new URL(relativeUrl, baseUrl);

      // Only allow http/https resolved URLs
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        return null;
      }

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
   * Check if a URL should be excluded from crawling.
   * In "audit" mode, only non-page resources and infrastructure paths are excluded.
   * In "seo" mode (default), auth pages, search/filter/sort query params are also excluded.
   */
  shouldExclude(
    url: string,
    excludePatterns: RegExp[] = [],
    mode: "seo" | "audit" = "seo",
  ): boolean {
    // Non-HTML file extensions — always excluded in both modes
    const nonPageExtensions =
      /\.(jpg|jpeg|png|gif|svg|webp|ico|bmp|tiff|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|tar|gz|mp3|mp4|avi|mov|wmv|flv|wav|ogg|txt|md|xml|json|csv|yaml|yml|css|js|woff|woff2|ttf|eot|map)$/i;

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      const queryString = urlObj.search;

      if (nonPageExtensions.test(pathname)) return true;

      // Infrastructure paths — always excluded
      const infrastructurePatterns = [
        /\/(wp-admin|wp-includes|wp-content\/plugins)\//i,
        /\/admin\//i,
        /\/ajax\//i,
        /\/api\//i,
      ];
      if (infrastructurePatterns.some((p) => p.test(pathname))) return true;

      // SEO-only exclusions (skip in audit mode so completeness checks work)
      if (mode === "seo") {
        if (/login|logout|register|signin|signup/i.test(pathname)) return true;
        // Query-string exclusions — only match after "?"
        if (queryString) {
          if (/[?&](search|filter|sort)=/i.test(queryString)) return true;
        }
      }

      // Custom patterns from caller
      if (excludePatterns.some((p) => p.test(url))) return true;

      return false;
    } catch {
      return excludePatterns.some((p) => p.test(url));
    }
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
   * Clean and validate a URL before processing
   */
  validateAndClean(url: string): string | null {
    try {
      // Basic validation
      if (!url || typeof url !== "string" || url.trim().length === 0) {
        return null;
      }

      const trimmed = url.trim();

      // Skip non-HTTP protocols and fragments
      if (trimmed === "#" || isNonHttpUrl(trimmed)) {
        return null;
      }

      // Catch mangled URLs like "https://mailto:..." or "https://tel:..."
      if (/^https?:\/\/(mailto|tel|javascript|sms|ftp):/i.test(trimmed)) {
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
