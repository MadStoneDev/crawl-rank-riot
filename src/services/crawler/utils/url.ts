/**
 * URL handling utilities for the crawler
 */

/**
 * URL processor class that handles all URL operations
 */
export class UrlProcessor {
  private domain: string;
  private baseUrl: URL;

  /**
   * Creates a new URL processor
   * @param baseUrl Base URL or domain for the crawl
   */
  constructor(baseUrl: string) {
    // Ensure base URL has protocol
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      baseUrl = "https://" + baseUrl;
    }

    this.baseUrl = new URL(baseUrl);
    this.domain = this.baseUrl.hostname;
  }

  /**
   * Gets the domain being processed
   * @returns Domain name
   */
  getDomain(): string {
    return this.domain;
  }

  /**
   * Gets the origin (protocol + domain)
   * @returns Origin
   */
  getOrigin(): string {
    return this.baseUrl.origin;
  }

  /**
   * Normalizes a URL
   * - Standardizes format
   * - Removes trailing slashes from non-root URLs
   * - Preserves query parameters
   * @param url URL to normalize
   * @returns Normalized URL
   */
  normalize(url: string): string {
    try {
      const urlObj = new URL(url);

      // Convert to lowercase
      let normalized = `${urlObj.protocol}//${urlObj.hostname.toLowerCase()}${
        urlObj.pathname
      }`;

      // Remove trailing slash for non-root paths
      if (normalized.length > 1 && normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }

      // Keep the query params if they exist
      if (urlObj.search) {
        normalized += urlObj.search;
      }

      return normalized;
    } catch (error) {
      return url; // Return original if parsing fails
    }
  }

  /**
   * Resolves a relative URL against the base URL
   * @param base Base URL
   * @param relative Relative URL
   * @returns Resolved absolute URL
   */
  resolve(base: string, relative: string): string {
    try {
      // Handle empty or invalid URLs
      if (!relative || relative === "#" || relative.startsWith("javascript:")) {
        return "";
      }

      const fullUrl = new URL(relative, base).toString();
      return this.normalize(fullUrl);
    } catch (error) {
      return ""; // Return empty string for invalid URLs
    }
  }

  /**
   * Checks if a URL is internal to the current domain
   * @param url URL to check
   * @returns True if URL is internal
   */
  isInternal(url: string): boolean {
    try {
      // Special cases
      if (url.startsWith("mailto:") || url.startsWith("tel:")) {
        return false;
      }

      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      return (
        hostname === this.domain.toLowerCase() ||
        hostname === `www.${this.domain.toLowerCase()}` ||
        `www.${hostname}` === this.domain.toLowerCase()
      );
    } catch (error) {
      return false;
    }
  }

  /**
   * Checks if a URL should be excluded based on patterns
   * @param url URL to check
   * @param patterns Array of regex patterns to match against
   * @returns True if URL should be excluded
   */
  shouldExclude(url: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(url));
  }

  /**
   * Extracts URLs from JavaScript content
   * @param content JavaScript content
   * @returns Array of extracted URLs
   */
  extractUrlsFromJS(content: string): string[] {
    const urls: string[] = [];

    // URL pattern
    const urlPattern = /["'](https?:\/\/[^"'\s]+)["']/g;
    let match;

    while ((match = urlPattern.exec(content)) !== null) {
      if (match[1] && !urls.includes(match[1])) {
        urls.push(match[1]);
      }
    }

    return urls;
  }

  /**
   * Extracts paths that might represent routes from JavaScript
   * @param content JavaScript content
   * @returns Array of extracted paths
   */
  extractPathsFromJS(content: string): string[] {
    const paths: Set<string> = new Set();

    // Common route patterns in frameworks
    const patterns = [
      // React Router style
      /path:\s*["'](\/[^"']+)["']/g,
      // Vue Router style
      /routes:.*?path:\s*["'](\/[^"']+)["']/g,
      // Next.js pages
      /pages\/([^.]+)\.js/g,
      // General path strings
      /["'](\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)["']/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1] && match[1].length > 1) {
          // Filter out likely non-route paths
          if (
            !match[1].includes(" ") &&
            !match[1].includes("{") &&
            !match[1].includes("}") &&
            !match[1].includes("*")
          ) {
            paths.add(match[1]);
          }
        }
      }
    }

    return Array.from(paths);
  }

  /**
   * Generate pagination pattern URLs from existing URLs
   * @param urls List of URLs to analyze for pagination patterns
   * @returns New URLs to crawl based on pagination patterns
   */
  generatePaginationUrls(urls: string[]): string[] {
    const newUrls: string[] = [];

    // Common pagination patterns
    const patterns = [
      { regex: /\/page\/(\d+)/, replace: "/page/" }, // WordPress
      { regex: /[\?&]page=(\d+)/, replace: "page=" }, // Query param
      { regex: /[\?&]p=(\d+)/, replace: "p=" }, // Short form
      { regex: /\/(\d+)\//, replace: "/" }, // Simple numeric
    ];

    for (const pattern of patterns) {
      // Find URLs matching this pattern
      const matchingUrls = urls.filter((url) => pattern.regex.test(url));

      if (matchingUrls.length >= 2) {
        // Find the highest page number
        const pageNumbers = matchingUrls.map((url) => {
          const match = url.match(pattern.regex);
          return match ? parseInt(match[1], 10) : 0;
        });

        const maxPage = Math.max(...pageNumbers);

        if (maxPage > 1) {
          // Use the first URL as template
          const templateUrl = matchingUrls[0];

          // Generate URLs for the next few pages
          for (let i = maxPage + 1; i <= maxPage + 3; i++) {
            const newUrl = templateUrl.replace(pattern.regex, (match) => {
              return match.replace(/\d+/, i.toString());
            });

            newUrls.push(newUrl);
          }
        }
      }
    }

    return newUrls;
  }
}
