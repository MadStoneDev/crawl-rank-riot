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
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] Attempting to process sitemap at: ${sitemapUrl}`,
    );

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      console.log(`[${timestamp}] Fetching sitemap from: ${sitemapUrl}`);
      const response = await fetch(sitemapUrl, {
        headers: {
          "User-Agent": this.userAgent,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(
          `[${timestamp}] Failed to fetch sitemap at ${sitemapUrl}: HTTP ${response.status}`,
        );
        return [];
      }

      const contentType = response.headers.get("content-type") || "";
      console.log(`[${timestamp}] Sitemap content type: ${contentType}`);

      let content: string;

      // Handle gzipped sitemaps
      if (contentType.includes("gzip") || sitemapUrl.endsWith(".gz")) {
        console.warn(
          `[${timestamp}] Skipping gzipped sitemap at ${sitemapUrl}`,
        );
        return [];
      } else {
        content = await response.text();
        console.log(
          `[${timestamp}] Received sitemap content (length: ${content.length} bytes)`,
        );
      }

      // Check if this is a sitemap index or a regular sitemap
      if (content.includes("<sitemapindex")) {
        console.log(`[${timestamp}] Detected sitemap index at ${sitemapUrl}`);
        return this.processSitemapIndex(content, sitemapUrl);
      } else {
        console.log(
          `[${timestamp}] Processing regular sitemap at ${sitemapUrl}`,
        );
        const urls = this.processSitemap(content);
        console.log(
          `[${timestamp}] Found ${urls.length} URLs in sitemap ${sitemapUrl}`,
        );
        return urls;
      }
    } catch (error) {
      console.error(
        `[${timestamp}] Error processing sitemap at ${sitemapUrl}:`,
        error,
      );
      return [];
    }
  }

  /**
   * Process common sitemap locations for a domain
   * @param domain Domain to check for sitemaps
   * @returns Array of URLs found across all sitemaps
   */
  async processCommonLocations(domain: string): Promise<string[]> {
    const timestamp = new Date().toISOString();
    console.log(
      `[${timestamp}] Checking common sitemap locations for domain: ${domain}`,
    );

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

      "/xmlsitemap.php?type=products&page=1", // BigCommerce
      "/xmlsitemap.php?type=pages&page=1", // BigCommerce
    ];

    console.log(
      `[${timestamp}] Checking ${possibleSitemapPaths.length} possible sitemap locations`,
    );

    for (const path of possibleSitemapPaths) {
      try {
        const sitemapUrl = `https://${domain}${path}`;
        console.log(`[${timestamp}] Checking sitemap at: ${sitemapUrl}`);

        // Skip already processed sitemaps
        if (processedSitemaps.has(sitemapUrl)) {
          console.log(
            `[${timestamp}] Skipping already processed sitemap: ${sitemapUrl}`,
          );
          continue;
        }

        processedSitemaps.add(sitemapUrl);
        const urls = await this.process(sitemapUrl);

        if (urls.length > 0) {
          console.log(
            `[${timestamp}] Found ${urls.length} URLs in sitemap at ${sitemapUrl}`,
          );
          for (const url of urls) {
            if (!allUrls.includes(url)) {
              allUrls.push(url);
            }
          }
        } else {
          console.log(
            `[${timestamp}] No URLs found in sitemap at ${sitemapUrl}`,
          );
        }
      } catch (error) {
        console.warn(
          `[${timestamp}] Error checking sitemap at ${path}:`,
          error,
        );
      }
    }

    console.log(
      `[${timestamp}] Found a total of ${allUrls.length} unique URLs across all sitemap locations`,
    );

    return allUrls;
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
