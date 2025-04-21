import { config } from "../../../config";
import { CrawlerError, ErrorCode } from "../../../utils/error";

/**
 * Data extracted from robots.txt
 */
export interface RobotsData {
  sitemaps: string[];
  crawlDelay?: number;
  allowedPaths: string[];
  disallowedPaths: string[];
}

/**
 * Options for the robots parser
 */
export interface RobotsParserOptions {
  userAgent?: string;
  timeout?: number;
}

/**
 * Parses robots.txt files to extract crawl directives
 */
export class RobotsParser {
  private readonly userAgent: string;
  private readonly timeout: number;

  /**
   * Creates a new robots.txt parser
   * @param options Parser options
   */
  constructor(options: RobotsParserOptions = {}) {
    this.userAgent = options.userAgent || config.crawler.userAgent;
    this.timeout = options.timeout || 5000; // 5 seconds timeout
  }

  /**
   * Parse robots.txt file for a given domain
   * @param domain Domain to parse robots.txt for
   * @returns Parsed robots data
   */
  async parse(domain: string): Promise<RobotsData> {
    const result: RobotsData = {
      sitemaps: [],
      allowedPaths: [],
      disallowedPaths: [],
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`https://${domain}/robots.txt`, {
        headers: {
          "User-Agent": this.userAgent,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return result;
      }

      const text = await response.text();
      const lines = text.split(/\r?\n/);

      // Track which user agent section we're in
      let currentUserAgent: string | null = null;
      const ourUserAgent = this.userAgent.split("/")[0].toLowerCase();
      const wildcard = "*";

      for (let line of lines) {
        // Remove comments
        line = line.split("#")[0].trim();

        if (!line) continue;

        // Extract key-value pairs
        const [key, ...valueParts] = line.split(":");
        let value = valueParts.join(":").trim();

        const keyLower = key.toLowerCase().trim();

        // Handle User-agent
        if (keyLower === "user-agent") {
          currentUserAgent = value.toLowerCase();
          continue;
        }

        // Handle Sitemap (global, not tied to a user agent)
        if (keyLower === "sitemap" && value) {
          result.sitemaps.push(value);
          continue;
        }

        // Skip rules that don't apply to our user agent
        if (
          currentUserAgent !== ourUserAgent &&
          currentUserAgent !== wildcard
        ) {
          continue;
        }

        // Handle Crawl-delay
        if (keyLower === "crawl-delay" && value) {
          const delay = parseFloat(value);
          if (!isNaN(delay)) {
            result.crawlDelay = delay * 1000; // Convert to milliseconds
          }
          continue;
        }

        // Handle Allow
        if (keyLower === "allow" && value) {
          result.allowedPaths.push(value);
          continue;
        }

        // Handle Disallow
        if (keyLower === "disallow" && value) {
          result.disallowedPaths.push(value);
          continue;
        }
      }

      return result;
    } catch (error) {
      console.warn(`Error parsing robots.txt for ${domain}:`, error);
      return result; // Return empty result on error
    }
  }

  /**
   * Check if a path is allowed to be crawled
   * @param path Path to check
   * @param robotsData Robots data to check against
   * @returns True if path is allowed
   */
  isPathAllowed(path: string, robotsData: RobotsData): boolean {
    // Empty disallow means everything is allowed
    if (robotsData.disallowedPaths.length === 0) {
      return true;
    }

    // Check for explicit allow rules (they take precedence over disallow)
    for (const allowPattern of robotsData.allowedPaths) {
      if (this.matchesPattern(path, allowPattern)) {
        return true;
      }
    }

    // Check for disallow rules
    for (const disallowPattern of robotsData.disallowedPaths) {
      if (this.matchesPattern(path, disallowPattern)) {
        return false;
      }
    }

    // If no rules match, allow by default
    return true;
  }

  /**
   * Check if a path matches a robots.txt pattern
   * @param path Path to check
   * @param pattern Pattern to match against
   * @returns True if path matches pattern
   */
  private matchesPattern(path: string, pattern: string): boolean {
    // Convert robots.txt pattern to regex
    let regexPattern = pattern
      .replace(/\?/g, "\\?") // Escape question marks
      .replace(/\./g, "\\.") // Escape dots
      .replace(/\*/g, ".*") // Convert * to .*
      .replace(/\$/g, "$"); // Keep end of line marker

    // Ensure pattern matches from the beginning
    if (!regexPattern.startsWith("^")) {
      regexPattern = "^" + regexPattern;
    }

    try {
      const regex = new RegExp(regexPattern);
      return regex.test(path);
    } catch (error) {
      // Fall back to simple string check if regex is invalid
      return path.startsWith(pattern);
    }
  }
}
