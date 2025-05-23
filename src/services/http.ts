import { Scanner } from "./scanner";
import { UrlProcessor } from "../utils/url";
import { CrawlOptions, ScanResult } from "../types";

export class WebCrawler {
  private scanner: Scanner;
  private urlProcessor: UrlProcessor;
  private visited = new Set<string>();
  private queue: Array<{ url: string; depth: number }> = [];
  private results: ScanResult[] = [];

  constructor(baseUrl: string) {
    this.scanner = new Scanner();
    this.urlProcessor = new UrlProcessor(baseUrl);
  }

  async crawl(
    seedUrl: string,
    options: CrawlOptions = {},
  ): Promise<ScanResult[]> {
    const {
      maxDepth = 3,
      maxPages = 100,
      concurrentRequests = 3,
      timeout = 60000,
      excludePatterns = [
        /\.(jpg|jpeg|png|gif|svg|webp|pdf|doc|docx|xls|xlsx|zip)$/i,
        /\/(wp-admin|wp-includes)/i,
        /#.*/i,
        /\?utm_/i,
      ],
      forceHeadless = false, // NEW option
    } = options;

    // Initialize
    this.visited.clear();
    this.queue = [];
    this.results = [];

    // Add seed URL
    const normalizedSeed = this.urlProcessor.normalize(seedUrl);
    this.queue.push({ url: normalizedSeed, depth: 0 });

    const startTime = Date.now();
    const workers: Promise<void>[] = [];

    // Detect if this is a Shopify site and adjust settings
    const isShopify = this.isShopifySite(seedUrl);
    const actualConcurrency = isShopify
      ? Math.min(concurrentRequests, 2)
      : concurrentRequests;
    const actualTimeout = isShopify ? Math.max(timeout, 120000) : timeout;

    console.log(
      `🚀 Starting crawl${
        isShopify ? " (Shopify detected)" : ""
      } with ${actualConcurrency} workers`,
    );

    // Start concurrent workers
    for (let i = 0; i < actualConcurrency; i++) {
      workers.push(
        this.worker(
          maxDepth,
          maxPages,
          excludePatterns,
          actualTimeout,
          startTime,
          forceHeadless || isShopify,
        ),
      );
    }

    await Promise.all(workers);
    return this.results;
  }

  private isShopifySite(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return (
      lowerUrl.includes("shopify") ||
      lowerUrl.includes("myshopify.com") ||
      lowerUrl.includes("shopifypreview.com")
    );
  }

  private async worker(
    maxDepth: number,
    maxPages: number,
    excludePatterns: RegExp[],
    timeout: number,
    startTime: number,
    forceHeadless: boolean, // NEW parameter
  ): Promise<void> {
    while (
      this.queue.length > 0 &&
      this.results.length < maxPages &&
      Date.now() - startTime < timeout
    ) {
      const item = this.queue.shift();
      if (!item || this.visited.has(item.url) || item.depth > maxDepth) {
        continue;
      }

      // Check exclude patterns
      if (excludePatterns.some((pattern) => pattern.test(item.url))) {
        continue;
      }

      this.visited.add(item.url);

      try {
        console.log(`🔍 Scanning (depth ${item.depth}): ${item.url}`);

        // Pass forceHeadless parameter to scanner
        const result = await this.scanner.scan(
          item.url,
          item.depth,
          forceHeadless,
        );
        this.results.push(result);

        console.log(
          `✅ Found: ${result.title} (${result.internal_links.length} internal links)`,
        );

        // Add internal links to queue
        if (item.depth < maxDepth) {
          for (const link of result.internal_links) {
            if (!this.visited.has(link.url) && !this.isInQueue(link.url)) {
              this.queue.push({ url: link.url, depth: item.depth + 1 });
            }
          }
        }

        // Longer delay for headless scans
        const delay = forceHeadless ? 2000 : 500;
        await this.delay(delay);
      } catch (error) {
        console.error(`❌ Error scanning ${item.url}:`, error);
      }
    }
  }

  private isInQueue(url: string): boolean {
    return this.queue.some((item) => item.url === url);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
