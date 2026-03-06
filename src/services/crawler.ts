import { Scanner } from "./scanner";
import { UrlProcessor } from "../utils/url";
import { CrawlOptions, ScanResult } from "../types";
import { getSupabaseServiceClient } from "./database/client";

export class WebCrawler {
  private scanner: Scanner;
  private urlProcessor: UrlProcessor;
  private visited = new Set<string>();
  private queued = new Set<string>(); // Track URLs already added to queue to prevent duplicates
  private queue: Array<{ url: string; depth: number }> = [];
  private results: ScanResult[] = [];
  private processing = new Set<string>(); // Track URLs being processed
  private maxConcurrentRequests: number = 3;

  private scanId: string | null = null;
  private projectId: string | null = null;
  private lastProgressUpdate: number = 0;
  private progressUpdateInterval: number = 1000; // Update every 2 seconds

  constructor(baseUrl: string, scanId?: string, projectId?: string) {
    this.scanner = new Scanner();
    this.urlProcessor = new UrlProcessor(baseUrl);
    this.scanId = scanId || null;
    this.projectId = projectId || null;
  }

  private async processUrl(
    item: { url: string; depth: number },
    maxDepth: number,
    maxPages: number,
    excludePatterns: RegExp[],
    forceHeadless: boolean,
  ): Promise<void> {
    try {
      // Skip if we've hit limits
      if (this.results.length >= maxPages || item.depth > maxDepth) {
        return;
      }

      // Use the URL processor's shouldExclude method combined with provided patterns
      if (this.urlProcessor.shouldExclude(item.url, excludePatterns)) {
        console.log(`🚫 Skipping excluded URL: ${item.url}`);
        return;
      }

      this.visited.add(item.url);

      console.log(`🔍 Scanning (depth ${item.depth}): ${item.url}`);

      // Detect if this needs special handling
      const needsHeadless =
        forceHeadless || this.isJavaScriptHeavySite(item.url);

      const result = await this.scanner.scan(
        item.url,
        item.depth,
        needsHeadless,
      );
      this.results.push(result);

      console.log(
        `✅ Scanned: ${result.title || "No title"} (${
          result.internal_links.length
        } internal links found)`,
      );

      // Update progress in database periodically
      await this.updateScanProgress();

      // Add internal links to queue if not at max depth
      if (item.depth < maxDepth) {
        const newLinks = this.processInternalLinks(
          result.internal_links,
          item.depth + 1,
        );
        console.log(`🔗 Added ${newLinks} new URLs to queue from ${item.url}`);
      }

      // Add delay between requests
      const delay = needsHeadless ? 2000 : 500;
      await this.delay(delay);
    } catch (error) {
      console.error(`❌ Error processing ${item.url}:`, error);
    } finally {
      // Remove from processing set
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

      // Calculate estimated completion percentage
      const estimatedTotalPages = Math.max(
        this.results.length * 1.5,
        this.queue.length + this.results.length,
      );
      const progressPercentage = Math.min(
        95,
        Math.round((this.results.length / estimatedTotalPages) * 100),
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
          status: "completed",
          completed_at: new Date().toISOString(),
          pages_scanned: this.results.length,
          links_scanned: totalLinksScanned,
          last_progress_update: new Date().toISOString(),
          summary_stats: {
            current_progress: 100,
            estimated_total: this.results.length,
            queue_size: 0,
            processing_count: 0,
            final_stats: {
              total_pages: this.results.length,
              total_links: totalLinksScanned,
              completion_time: new Date().toISOString(),
            },
          },
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
    } = options;
    // Default timeout scales with maxPages: ~2s per page, min 5 minutes
    const timeout = options.timeout ?? Math.max(300_000, maxPages * 2_000);

    console.log(`🚀 Starting crawl of ${seedUrl}`);
    console.log(
      `📊 Options: maxDepth=${maxDepth}, maxPages=${maxPages}, concurrent=${concurrentRequests}, timeout=${Math.round(timeout / 1000)}s`,
    );

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
      throw new Error(`Invalid seed URL: ${seedUrl}`);
    }

    // STEP 1: Detect preferred www format by checking redirects
    await this.urlProcessor.detectPreferredWwwFormat();
    console.log(`🌐 Base domain: ${this.urlProcessor.getBaseDomain()}`);

    // Add seed URL (will be normalized with correct www preference)
    const normalizedSeedUrl = this.urlProcessor.normalize(cleanSeedUrl);
    this.queue.push({ url: normalizedSeedUrl, depth: 0 });
    this.queued.add(normalizedSeedUrl);

    // Check for sitemaps first if enabled
    if (checkSitemaps) {
      await this.processSitemaps(normalizedSeedUrl, maxDepth);
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
    if (this.queue.length === 0) {
      console.log(`✅ Crawl finished: queue empty after ${Math.round(elapsed / 1000)}s`);
    } else if (this.results.length >= maxPages) {
      console.log(`✅ Crawl finished: reached maxPages limit (${maxPages}) after ${Math.round(elapsed / 1000)}s, ${this.queue.length} URLs remaining in queue`);
    } else {
      console.log(`⚠️ Crawl stopped: timeout reached (${Math.round(elapsed / 1000)}s / ${Math.round(timeout / 1000)}s), ${this.results.length}/${maxPages} pages scanned, ${this.queue.length} URLs remaining in queue`);
    }

    await this.finalProgressUpdate();

    console.log(`✅ Crawl completed: ${this.results.length} pages found`);
    return this.results;
  }

  private getNextBatch(size: number): Array<{ url: string; depth: number }> {
    const batch: Array<{ url: string; depth: number }> = [];

    while (batch.length < size && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      // Skip if already visited or being processed
      if (this.visited.has(item.url) || this.processing.has(item.url)) {
        continue;
      }

      batch.push(item);
      this.processing.add(item.url);
      this.visited.add(item.url); // Mark visited immediately to prevent race conditions
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

      // Check if URL should be excluded
      if (this.urlProcessor.shouldExclude(cleanUrl)) {
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

  private isInQueue(url: string): boolean {
    return this.queued.has(url);
  }

  private isJavaScriptHeavySite(url: string): boolean {
    const jsHeavyPlatforms = [
      "shopify.com",
      "shopifypreview.com",
      "myshopify.com",
      "squarespace.com",
      "wix.com",
      "webflow.io",
      "bigcommerce.com",
      "magento.com",
    ];

    const lowerUrl = url.toLowerCase();
    return jsHeavyPlatforms.some((platform) => lowerUrl.includes(platform));
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

        const response = await fetch(sitemapUrl, {
          headers: {
            "User-Agent": "RankRiot/1.0 SEO Crawler",
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

        const response = await fetch(sitemapUrl, {
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
            if (!this.visited.has(cleanUrl) && !this.queued.has(cleanUrl)) {
              // Calculate depth based on URL structure
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
    // Use the URL processor's getPathDepth method for consistency
    const pathDepth = this.urlProcessor.getPathDepth(url);
    return Math.min(pathDepth, 3); // Cap at depth 3
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
