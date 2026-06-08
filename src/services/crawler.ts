import { Scanner } from "./scanner";
import { UrlProcessor } from "../utils/url";
import { CrawlOptions, ScanResult } from "../types";
import { getSupabaseServiceClient } from "./database/client";
import { isJavaScriptHeavySite, closeSharedBrowserPool } from "../utils/browser";
import { ScanLogger } from "./scan-logger";
import { proxyFetch, isProxyConfigured } from "../utils/proxy";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class WebCrawler {
  private scanner: Scanner;
  private urlProcessor: UrlProcessor;
  private visited = new Set<string>();
  private queued = new Set<string>();
  private queue: Array<{ url: string; depth: number; retries?: number }> = [];
  private results: ScanResult[] = [];
  private processing = new Set<string>();
  private maxConcurrentRequests: number = 3;
  private crawlMode: "seo" | "audit" = "seo";
  public crawlCompleted = false;

  private scanId: string | null = null;
  private projectId: string | null = null;
  private lastProgressUpdate: number = 0;
  private progressUpdateInterval: number = 1000;
  public logger: ScanLogger | null = null;

  constructor(baseUrl: string, scanId?: string, projectId?: string) {
    this.scanner = new Scanner();
    this.urlProcessor = new UrlProcessor(baseUrl);
    this.scanId = scanId || null;
    this.projectId = projectId || null;
    if (scanId) {
      this.logger = new ScanLogger(scanId);
    }
  }

  private static readonly MAX_RETRIES = 2;

  private async processUrl(
    item: { url: string; depth: number; retries?: number },
    maxDepth: number,
    maxPages: number,
    excludePatterns: RegExp[],
    forceHeadless: boolean,
  ): Promise<void> {
    try {
      if (this.results.length >= maxPages || item.depth > maxDepth) {
        return;
      }

      if (this.urlProcessor.shouldExclude(item.url, excludePatterns, this.crawlMode)) {
        console.log(`🚫 Skipping excluded URL: ${item.url}`);
        return;
      }

      const needsHeadless =
        forceHeadless || isJavaScriptHeavySite(item.url);

      this.logger?.info("crawl", `Scanning ${item.url}`, { depth: item.depth, method: needsHeadless ? "headless" : "http" });

      const result = await this.scanner.scan(
        item.url,
        item.depth,
        needsHeadless,
      );

      // Treat 5xx and status 0 (connection failure) as transient — re-queue for retry
      if (result.status >= 500 || result.status === 0) {
        const retries = item.retries || 0;
        if (retries < WebCrawler.MAX_RETRIES) {
          this.logger?.warn("crawl", `Got ${result.status === 0 ? "connection failure" : `status ${result.status}`} for ${item.url}, retrying (${retries + 1}/${WebCrawler.MAX_RETRIES})`, { url: item.url, status: result.status, errors: result.errors });
          this.queue.push({ url: item.url, depth: item.depth, retries: retries + 1 });
          return;
        }
        this.logger?.error("crawl", `Failed to reach ${item.url} after ${WebCrawler.MAX_RETRIES} retries (status=${result.status})`, { url: item.url, status: result.status, errors: result.errors });
      }

      this.visited.add(item.url);

      // Skip pages blocked by bot protection — don't overwrite real data with challenge page content
      const isBlocked = result.errors?.some(e => e.includes("Blocked by bot protection"));
      if (isBlocked) {
        this.logger?.warn("crawl", `Blocked by bot protection: ${item.url}`, { url: item.url });
        await this.updateScanProgress();
        return;
      }

      // Skip pages that completely failed to load (status 0 = no response at all)
      if (result.status === 0) {
        this.logger?.error("crawl", `Skipping unreachable page: ${item.url}`, { url: item.url, errors: result.errors });
        await this.updateScanProgress();
        return;
      }

      this.results.push(result);

      this.logger?.info("crawl", `Scanned: ${result.title || "No title"} (${result.status}) — ${result.internal_links.length} internal links, ${result.word_count || 0} words`, {
        url: item.url,
        status: result.status,
        title: result.title || null,
        word_count: result.word_count || 0,
        internal_links: result.internal_links.length,
        external_links: result.external_links.length,
        method: result.scan_method || "unknown",
        load_time_ms: result.load_time_ms,
      });

      await this.updateScanProgress();

      if (item.depth < maxDepth) {
        const newLinks = this.processInternalLinks(
          result.internal_links,
          item.depth + 1,
        );
        if (newLinks > 0) {
          this.logger?.info("crawl", `Queued ${newLinks} new URLs from ${item.url}`, { url: item.url, new_links: newLinks });
        }
      }

      const delay = needsHeadless ? 2000 : 500;
      await this.delay(delay);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger?.error("crawl", `Error processing ${item.url}: ${msg}`, { url: item.url, error: msg });
      const retries = item.retries || 0;
      if (retries < WebCrawler.MAX_RETRIES) {
        this.logger?.info("crawl", `Re-queuing ${item.url} for retry (${retries + 1}/${WebCrawler.MAX_RETRIES})`);
        this.queue.push({ url: item.url, depth: item.depth, retries: retries + 1 });
      } else {
        this.visited.add(item.url);
      }
    } finally {
      this.processing.delete(item.url);
    }
  }

  /**
   * Update scan progress in database
   */
  private async updateScanProgress(): Promise<void> {
    if (!this.scanId || !this.projectId) {
      return; // No scan to update
    }

    const now = Date.now();

    // Only update if enough time has passed (avoid too frequent updates)
    if (now - this.lastProgressUpdate < this.progressUpdateInterval) {
      return;
    }

    try {
      const supabase = getSupabaseServiceClient();

      // Calculate total links scanned
      const totalLinksScanned = this.results.reduce(
        (total, page) =>
          total + page.internal_links.length + page.external_links.length,
        0,
      );

      // Calculate estimated completion percentage based on pages processed (visited), not just successful results
      const pagesProcessed = this.visited.size;
      const estimatedTotalPages = Math.max(
        pagesProcessed * 1.5,
        this.queue.length + pagesProcessed,
      );
      const progressPercentage = Math.min(
        95,
        Math.round((pagesProcessed / Math.max(1, estimatedTotalPages)) * 100),
      );

      await supabase
        .from("scans")
        .update({
          pages_scanned: this.results.length,
          links_scanned: totalLinksScanned,
          last_progress_update: new Date().toISOString(),
          summary_stats: {
            current_progress: progressPercentage,
            estimated_total: Math.round(estimatedTotalPages),
            queue_size: this.queue.length,
            processing_count: this.processing.size,
            last_update: new Date().toISOString(),
          },
        })
        .eq("id", this.scanId);

      this.lastProgressUpdate = now;
      console.log(
        `📊 Progress updated: ${this.results.length} pages, ${progressPercentage}% complete`,
      );
    } catch (error) {
      console.error("❌ Error updating scan progress:", error);
      // Don't throw - progress updates are not critical
    }
  }

  /**
   * Force a final progress update
   */
  private async finalProgressUpdate(): Promise<void> {
    if (!this.scanId || !this.projectId) {
      return;
    }

    try {
      const { getSupabaseServiceClient } = await import("./database/client");
      const supabase = getSupabaseServiceClient();

      const totalLinksScanned = this.results.reduce(
        (total, page) =>
          total + page.internal_links.length + page.external_links.length,
        0,
      );

      await supabase
        .from("scans")
        .update({
          pages_scanned: this.results.length,
          links_scanned: totalLinksScanned,
          last_progress_update: new Date().toISOString(),
        })
        .eq("id", this.scanId);

      console.log(
        `✅ Final progress update: ${this.results.length} pages completed`,
      );
    } catch (error) {
      console.error("❌ Error with final progress update:", error);
    }
  }

  async crawl(
    seedUrl: string,
    options: CrawlOptions = {},
  ): Promise<ScanResult[]> {
    const {
      maxDepth = 3,
      maxPages = 100,
      concurrentRequests = 3,
      excludePatterns = [],
      checkSitemaps = true,
      forceHeadless = false,
      crawlMode = "seo",
    } = options;
    this.crawlMode = crawlMode;
    // Default timeout scales with maxPages: ~2s per page, min 5 minutes
    const timeout = options.timeout ?? Math.max(300_000, maxPages * 2_000);

    const usingProxy = isProxyConfigured();
    this.logger?.info("init", `Starting crawl of ${seedUrl}${usingProxy ? " (via proxy)" : ""}`, {
      maxDepth, maxPages, concurrentRequests, timeout: Math.round(timeout / 1000), proxy: usingProxy,
      forceHeadless, checkSitemaps, crawlMode,
    });

    // Initialize
    this.visited.clear();
    this.queued.clear();
    this.queue = [];
    this.results = [];
    this.processing.clear();
    this.maxConcurrentRequests = concurrentRequests;

    // Validate and clean the seed URL
    const cleanSeedUrl = this.urlProcessor.validateAndClean(seedUrl);
    if (!cleanSeedUrl) {
      this.logger?.error("init", `Invalid seed URL: ${seedUrl}`);
      throw new Error(`Invalid seed URL: ${seedUrl}`);
    }

    // STEP 1: Detect preferred www format by checking redirects
    await this.urlProcessor.detectPreferredWwwFormat();
    const baseDomain = this.urlProcessor.getBaseDomain();
    this.logger?.info("init", `Base domain resolved: ${baseDomain}`);

    // Add seed URL (will be normalized with correct www preference)
    const normalizedSeedUrl = this.urlProcessor.normalize(cleanSeedUrl);
    this.queue.push({ url: normalizedSeedUrl, depth: 0 });
    this.queued.add(normalizedSeedUrl);

    // Check for sitemaps first if enabled
    if (checkSitemaps) {
      this.logger?.info("sitemap", "Checking for sitemaps...");
      await this.processSitemaps(normalizedSeedUrl, maxDepth);
      this.logger?.info("sitemap", `Sitemap processing complete, ${this.queue.length} URLs queued`);
    }

    const startTime = Date.now();

    // Process queue with proper concurrency control
    while (
      this.queue.length > 0 &&
      this.results.length < maxPages &&
      Date.now() - startTime < timeout
    ) {
      // Get next batch of URLs to process
      const batch = this.getNextBatch(
        Math.min(this.maxConcurrentRequests, this.queue.length),
      );

      if (batch.length === 0) {
        console.log("⏳ No more URLs to process, waiting for current batch...");
        await this.delay(1000);
        continue;
      }

      // Process batch concurrently
      const promises = batch.map((item) =>
        this.processUrl(
          item,
          maxDepth,
          maxPages,
          excludePatterns,
          forceHeadless,
        ),
      );

      await Promise.allSettled(promises);

      console.log(
        `📈 Progress: ${this.results.length}/${maxPages} pages, ${this.queue.length} in queue`,
      );

      // STEP 2: After first batch, refine www preference using link analysis
      if (this.results.length >= 5 && this.results.length <= 10) {
        console.log("🔄 Refining www preference with link analysis...");
        await this.urlProcessor.detectPreferredWwwFormat(this.results);
      }
    }

    // Log why the loop exited
    const elapsed = Date.now() - startTime;
    const blocked = this.visited.size - this.results.length;
    if (this.queue.length === 0) {
      this.crawlCompleted = true;
      this.logger?.info("crawl", `Crawl finished: queue empty after ${Math.round(elapsed / 1000)}s`, {
        pages_found: this.results.length, pages_blocked: blocked, elapsed_s: Math.round(elapsed / 1000),
      });
    } else if (this.results.length >= maxPages) {
      this.crawlCompleted = false;
      this.logger?.warn("crawl", `Crawl stopped: reached maxPages limit (${maxPages})`, {
        pages_found: this.results.length, queue_remaining: this.queue.length, elapsed_s: Math.round(elapsed / 1000),
      });
    } else {
      this.crawlCompleted = false;
      this.logger?.warn("crawl", `Crawl stopped: timeout reached (${Math.round(timeout / 1000)}s)`, {
        pages_found: this.results.length, queue_remaining: this.queue.length, elapsed_s: Math.round(elapsed / 1000),
      });
    }

    await this.finalProgressUpdate();
    await closeSharedBrowserPool();

    this.logger?.info("complete", `Crawl complete: ${this.results.length} pages found, ${blocked} blocked, ${Math.round(elapsed / 1000)}s elapsed`);
    return this.results;
  }

  private getNextBatch(size: number): Array<{ url: string; depth: number; retries?: number }> {
    const batch: Array<{ url: string; depth: number; retries?: number }> = [];

    while (batch.length < size && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      if (this.visited.has(item.url) || this.processing.has(item.url)) {
        continue;
      }

      batch.push(item);
      this.processing.add(item.url);
    }

    return batch;
  }

  private processInternalLinks(
    internalLinks: Array<{
      url: string;
      anchor_text: string;
      rel_attributes: string[];
    }>,
    depth: number,
  ): number {
    let addedCount = 0;

    // Create array of links with priorities for sorting
    const linksWithPriority = [];

    for (const link of internalLinks) {
      // Use validateAndClean to ensure URL is valid
      const cleanUrl = this.urlProcessor.validateAndClean(link.url);
      if (!cleanUrl) {
        continue;
      }

      // Skip if already visited, queued, or being processed
      if (
        this.visited.has(cleanUrl) ||
        this.queued.has(cleanUrl) ||
        this.processing.has(cleanUrl)
      ) {
        continue;
      }

      if (this.urlProcessor.shouldExclude(cleanUrl, [], this.crawlMode)) {
        console.log(`🚫 Excluding URL: ${cleanUrl}`);
        continue;
      }

      // Calculate priority for this URL
      const priority = this.urlProcessor.getCrawlPriority(cleanUrl, depth);

      linksWithPriority.push({
        url: cleanUrl,
        depth,
        priority,
        anchor: link.anchor_text,
      });
    }

    // Sort by priority (highest first) and add to queue
    linksWithPriority
      .sort((a, b) => b.priority - a.priority)
      .forEach((link) => {
        this.queue.push({ url: link.url, depth: link.depth });
        this.queued.add(link.url);
        addedCount++;

        if (link.priority > 7) {
          console.log(
            `⭐ High priority URL added: ${link.url} (priority: ${link.priority})`,
          );
        }
      });

    return addedCount;
  }

  private async processSitemaps(
    baseUrl: string,
    maxDepth: number,
  ): Promise<void> {
    console.log("🗺️ Checking for sitemaps...");

    const sitemapUrls = [
      `${baseUrl}/sitemap.xml`,
      `${baseUrl}/sitemap_index.xml`,
      `${baseUrl}/product-sitemap.xml`,
      `${baseUrl}/pages-sitemap.xml`,
      `${baseUrl}/robots.txt`, // Will check for sitemap references
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await proxyFetch(sitemapUrl, {
          headers: {
            "User-Agent": BROWSER_USER_AGENT,
            "Accept": "text/xml,application/xml,text/html,*/*;q=0.8",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const content = await response.text();

          if (sitemapUrl.endsWith("robots.txt")) {
            // Extract sitemap URLs from robots.txt
            const sitemapMatches = content.match(
              /sitemap:\s*(https?:\/\/[^\s]+)/gi,
            );
            if (sitemapMatches) {
              for (const match of sitemapMatches) {
                const url = match.replace(/sitemap:\s*/i, "").trim();
                await this.processSingleSitemap(url, maxDepth);
              }
            }
          } else {
            // Process XML sitemap
            await this.processSingleSitemap(sitemapUrl, maxDepth, content);
          }
        }
      } catch (error) {
        console.log(`⚠️ Failed to fetch sitemap ${sitemapUrl}:`, error);
      }
    }
  }

  private async processSingleSitemap(
    sitemapUrl: string,
    maxDepth: number,
    content?: string,
  ): Promise<void> {
    try {
      if (!content) {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await proxyFetch(sitemapUrl, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) return;
        content = await response.text();
      }

      console.log(`📄 Processing sitemap: ${sitemapUrl}`);

      // Check for sitemap index (contains other sitemaps)
      if (content.includes("<sitemapindex")) {
        const sitemapMatches = content.match(/<loc>(.*?)<\/loc>/g);
        if (sitemapMatches) {
          for (const match of sitemapMatches.slice(0, 10)) {
            // Limit to 10 sitemaps
            const url = match.replace(/<\/?loc>/g, "");
            await this.processSingleSitemap(url, maxDepth);
          }
        }
        return;
      }

      // Process regular sitemap
      const urlMatches = content.match(/<loc>(.*?)<\/loc>/g);
      if (urlMatches) {
        let addedFromSitemap = 0;

        for (const match of urlMatches) {
          const url = match.replace(/<\/?loc>/g, "").trim();

          // Use validateAndClean to ensure URL is valid
          const cleanUrl = this.urlProcessor.validateAndClean(url);
          if (!cleanUrl) continue;

          if (this.urlProcessor.isInternal(cleanUrl)) {
            if (
              !this.visited.has(cleanUrl) &&
              !this.queued.has(cleanUrl) &&
              !this.urlProcessor.shouldExclude(cleanUrl, [], this.crawlMode)
            ) {
              const urlDepth = this.calculateUrlDepth(
                cleanUrl,
                this.urlProcessor.getBaseUrl(),
              );

              if (urlDepth <= maxDepth) {
                this.queue.push({ url: cleanUrl, depth: urlDepth });
                this.queued.add(cleanUrl);
                addedFromSitemap++;
              }
            }
          }
        }

        console.log(
          `🗺️ Added ${addedFromSitemap} URLs from sitemap: ${sitemapUrl}`,
        );
      }
    } catch (error) {
      console.error(`❌ Error processing sitemap ${sitemapUrl}:`, error);
    }
  }

  private calculateUrlDepth(url: string, baseUrl: string): number {
    return this.urlProcessor.getPathDepth(url);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Public methods to access URL processor functionality
  public getBaseDomain(): string {
    return this.urlProcessor.getBaseDomain();
  }

  public isInternalUrl(url: string): boolean {
    return this.urlProcessor.isInternal(url);
  }

  public getUrlPriority(url: string, depth: number): number {
    return this.urlProcessor.getCrawlPriority(url, depth);
  }
}
