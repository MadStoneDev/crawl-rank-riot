import { config } from "../../../config";
import { CrawlerError, ErrorCode } from "../../../utils/error";

/**
 * Options for sitemap processor
 */
export interface SitemapProcessorOptions {
  userAgent?: string;
  timeout?: number;
  maxSitemapsToProcess?: number;
  ignoreSitemapErrors?: boolean;
}

/**
 * Processes XML sitemaps to extract URLs
 */
export class SitemapProcessor {
  private readonly userAgent: string;
  private readonly timeout: number;
  private readonly maxSitemapsToProcess: number;
  private readonly ignoreSitemapErrors: boolean;

  /**
   * Creates a new sitemap processor
   * @param options Processor options
   */
  constructor(options: SitemapProcessorOptions = {}) {
    this.userAgent = options.userAgent || config.crawler.userAgent;
    this.timeout = options.timeout || 10000; // 10 seconds timeout
    this.maxSitemapsToProcess = options.maxSitemapsToProcess || 5;
    this.ignoreSitemapErrors = options.ignoreSitemapErrors || true;
  }

  /**
   * Process a sitemap URL to extract contained URLs
   * @param sitemapUrl URL of the sitemap
   * @returns Array of URLs found in the sitemap
   */
  async process(sitemapUrl: string): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(sitemapUrl, {
        headers: {
          "User-Agent": this.userAgent,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(
          `Failed to fetch sitemap at ${sitemapUrl}: ${response.status}`,
        );
        return [];
      }

      const contentType = response.headers.get("content-type") || "";
      let content: string;

      // Handle gzipped sitemaps
      if (contentType.includes("gzip") || sitemapUrl.endsWith(".gz")) {
        // We can't easily handle gzip in the browser, so log and return empty
        console.warn(`Skipping gzipped sitemap at ${sitemapUrl}`);
        return [];
      } else {
        content = await response.text();
      }

      // Check if this is a sitemap index or a regular sitemap
      if (content.includes("<sitemapindex")) {
        return this.processSitemapIndex(content, sitemapUrl);
      } else {
        return this.processSitemap(content);
      }
    } catch (error) {
      if (this.ignoreSitemapErrors) {
        console.warn(`Error processing sitemap at ${sitemapUrl}:`, error);
        return [];
      } else {
        throw new CrawlerError(
          `Failed to process sitemap at ${sitemapUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ErrorCode.PARSE_ERROR,
        );
      }
    }
  }

  /**
   * Process common sitemap locations for a domain
   * @param domain Domain to check for sitemaps
   * @returns Array of URLs found across all sitemaps
   */
  async processCommonLocations(domain: string): Promise<string[]> {
    const allUrls: string[] = [];
    const processedSitemaps = new Set<string>();

    const possibleSitemapPaths = [
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/sitemap-index.xml",
      "/wp-sitemap.xml",
      "/sitemap.php",
      "/sitemap_index.php",
      "/xmlsitemap.php",
      "/sitemap/sitemap.xml",

      // Additional paths for common platforms
      "/post-sitemap.xml", // WordPress
      "/page-sitemap.xml", // WordPress
      "/product-sitemap.xml", // WooCommerce
      "/category-sitemap.xml", // WordPress categories
      "/xmlsitemap.php?type=pages", // Drupal
      "/xmlsitemap.php?type=nodes", // Drupal
    ];

    for (const path of possibleSitemapPaths) {
      try {
        const sitemapUrl = `https://${domain}${path}`;

        // Skip already processed sitemaps
        if (processedSitemaps.has(sitemapUrl)) {
          continue;
        }

        processedSitemaps.add(sitemapUrl);
        const urls = await this.process(sitemapUrl);

        if (urls.length > 0) {
          console.log(`Found ${urls.length} URLs in sitemap at ${sitemapUrl}`);
          allUrls.push(...urls);
        }
      } catch (error) {
        if (!this.ignoreSitemapErrors) {
          throw error;
        }
        console.warn(`Error checking sitemap at ${path}:`, error);
      }
    }

    // Remove duplicates before returning
    return [...new Set(allUrls)];
  }

  /**
   * Process a sitemap index file that contains links to multiple sitemaps
   * @param content Sitemap index XML content
   * @param baseUrl Base URL for resolving relative URLs
   * @returns Array of URLs from all child sitemaps
   */
  private async processSitemapIndex(
    content: string,
    baseUrl: string,
  ): Promise<string[]> {
    const allUrls: string[] = [];
    const regex = /<loc>(.*?)<\/loc>/g;

    // Extract all sitemap URLs
    const sitemapUrls: string[] = [];
    let match;

    while ((match = regex.exec(content)) !== null) {
      sitemapUrls.push(match[1].trim());
    }

    // Process each sitemap (limit to max number to avoid overloading)
    const limitedSitemaps = sitemapUrls.slice(0, this.maxSitemapsToProcess);

    const promises = limitedSitemaps.map(async (url) => {
      try {
        return await this.process(url);
      } catch (error) {
        if (this.ignoreSitemapErrors) {
          console.warn(`Error processing child sitemap at ${url}:`, error);
          return [];
        } else {
          throw error;
        }
      }
    });

    const results = await Promise.all(promises);

    // Combine all results
    for (const urls of results) {
      allUrls.push(...urls);
    }

    return allUrls;
  }

  /**
   * Process a regular sitemap file to extract URLs
   * @param content Sitemap XML content
   * @returns Array of URLs from the sitemap
   */
  private processSitemap(content: string): string[] {
    const urls: string[] = [];
    const regex = /<loc>(.*?)<\/loc>/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const url = match[1].trim();

      if (url) {
        // Clean URL entities
        const cleanUrl = url
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");

        urls.push(cleanUrl);
      }
    }

    return urls;
  }
}
