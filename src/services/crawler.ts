import { Scanner } from "./scanner";
import { UrlProcessor } from "../utils/url";
import { ScanResult, CrawlOptions } from "../types";

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

    // Start concurrent workers
    for (let i = 0; i < concurrentRequests; i++) {
      workers.push(
        this.worker(maxDepth, maxPages, excludePatterns, timeout, startTime),
      );
    }

    await Promise.all(workers);
    return this.results;
  }

  private async worker(
    maxDepth: number,
    maxPages: number,
    excludePatterns: RegExp[],
    timeout: number,
    startTime: number,
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
        const result = await this.scanner.scan(item.url, item.depth);
        this.results.push(result);

        // Add internal links to queue
        if (item.depth < maxDepth) {
          for (const link of result.internal_links) {
            if (!this.visited.has(link.url) && !this.isInQueue(link.url)) {
              this.queue.push({ url: link.url, depth: item.depth + 1 });
            }
          }
        }

        // Add delay to be respectful
        await this.delay(500);
      } catch (error) {
        console.error(`Error scanning ${item.url}:`, error);
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
