import { UrlProcessor } from "./url";

/**
 * Enhanced request utilities for web crawling
 */
export class RequestUtils {
  /**
   * Generates a realistic User-Agent string
   * @returns Randomized User-Agent
   */
  static getRotatedUserAgent(): string {
    const userAgents = [
      // Modern Chrome on Windows
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      // Modern Chrome on Mac
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      // Modern Firefox on Windows
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
      // Modern Safari on Mac
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      // Modern Edge on Windows
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    ];

    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  /**
   * Creates enhanced fetch headers to appear more like a legitimate browser
   * @param url Target URL
   * @param options Additional header options
   * @returns Enhanced request headers
   */
  static createEnhancedHeaders(
    url: string,
    options: {
      userAgent?: string;
      additionalHeaders?: Record<string, string>;
    } = {},
  ): Headers {
    const urlObj = new URL(url);
    const userAgent = options.userAgent || this.getRotatedUserAgent();

    const headers = new Headers({
      // Realistic User-Agent
      "User-Agent": userAgent,

      // Referrer to simulate navigation
      Referer: urlObj.origin,

      // Comprehensive Accept headers
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",

      // Additional headers to appear more like a browser
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",

      // Crawler identification (optional, but recommended for transparency)
      "X-Crawler-Name": "SEO-Platform-Crawler",
      "X-Crawler-Version": "1.0.0",
    });

    // Add any additional custom headers
    if (options.additionalHeaders) {
      Object.entries(options.additionalHeaders).forEach(([key, value]) => {
        headers.set(key, value);
      });
    }

    return headers;
  }

  /**
   * Enhanced fetch with better error handling and legitimacy
   * @param url URL to fetch
   * @param options Fetch options
   * @returns Fetch response
   */
  static async enhancedFetch(
    url: string,
    options: RequestInit & {
      userAgent?: string;
      additionalHeaders?: Record<string, string>;
      maxRetries?: number;
      retryDelay?: number;
      timeout?: number;
    } = {},
  ): Promise<Response> {
    const {
      maxRetries = 3,
      retryDelay = 1000,
      userAgent,
      additionalHeaders,
      timeout = 30000,
      ...fetchOptions
    } = options;

    const urlProcessor = new UrlProcessor(url);
    const normalizedUrl = urlProcessor.normalize(url);

    const headers = this.createEnhancedHeaders(normalizedUrl, {
      userAgent,
      additionalHeaders,
    });

    // Merge provided headers with our enhanced headers
    const mergedHeaders = new Headers(fetchOptions.headers || {});
    headers.forEach((value, key) => {
      if (!mergedHeaders.has(key)) {
        mergedHeaders.set(key, value);
      }
    });

    // Prepare fetch options
    const finalOptions: RequestInit = {
      ...fetchOptions,
      headers: mergedHeaders,
      redirect: "follow",
      credentials: "omit", // Avoid sending cookies
    };

    // Retry mechanism with exponential backoff
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const response = await fetch(normalizedUrl, {
          ...finalOptions,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Check if response is successful
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        return response;
      } catch (error) {
        // Log error
        console.warn(`Fetch attempt ${attempt + 1} failed:`, error);

        // If it's the last retry, throw the error
        if (attempt === maxRetries - 1) {
          throw error;
        }

        // Wait before retrying with exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelay * Math.pow(2, attempt)),
        );
      }
    }

    // This should never be reached due to the retry mechanism
    throw new Error("Failed to fetch after multiple attempts");
  }
}

export default RequestUtils;
