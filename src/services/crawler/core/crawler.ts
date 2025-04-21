import { Redis } from "@upstash/redis";
import { SupabaseClient } from "@supabase/supabase-js";

import { config } from "../../../config";
import { ScanResult } from "../../../types/common";
import { UrlProcessor } from "../utils/url";
import { QueueManager } from "./queue";
import { CrawlStateManager } from "./state";
import { RobotsParser, RobotsData } from "../processors/robots";
import { SitemapProcessor } from "../processors/sitemap";
import { HttpScanner } from "../scanners/http";
import { HeadlessBrowser } from "../scanners/browser";

/**
 * Options for configuring the crawler
 */
export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  concurrentRequests?: number;
  timeout?: number;
  excludePatterns?: RegExp[];
  useHeadlessBrowser?: boolean;
  headlessBrowserPaths?: string[];
  checkSitemaps?: boolean;
  useRedisQueue?: boolean;
  perDomainDelay?: number;
  defaultDelay?: number;
  userAgent?: string;
  followRedirects?: boolean;
  respectRobotsTxt?: boolean;
}

/**
 * Options for initializing the crawler
 */
export interface CrawlerInitOptions {
  scanId?: string;
  projectId?: string;
  redis?: Redis | null;
  supabase?: SupabaseClient | null;
}

/**
 * Main crawler class that coordinates the crawling process
 */
export class Crawler {
  private readonly scanId?: string;
  private readonly projectId?: string;
  private readonly redis: Redis | null;
  private readonly supabase: SupabaseClient | null;

  /**
   * Creates a new crawler instance
   * @param options Crawler initialization options
   */
  constructor(options: CrawlerInitOptions = {}) {
    this.scanId = options.scanId;
    this.projectId = options.projectId;
    this.redis = options.redis || null;
    this.supabase = options.supabase || null;
  }

  /**
   * Crawls a website beginning from the seed URL
   * @param url Seed URL to start crawling from
   * @param options Crawl configuration options
   * @returns Array of scan results
   */
  async crawlWebsite(
    url: string,
    options: CrawlOptions = {},
  ): Promise<ScanResult[]> {
    // Normalize options with defaults
    const {
      maxDepth = config.crawler.maxDepth,
      maxPages = config.crawler.maxPages,
      concurrentRequests = config.crawler.concurrentRequests,
      timeout = config.crawler.defaultTimeout,
      excludePatterns = [
        // Common patterns to exclude
        /\.(jpg|jpeg|png|gif|svg|webp|pdf|doc|docx|xls|xlsx|zip|tar)$/i,
        /\/(wp-admin|wp-includes|wp-content\/plugins)\//i,
        /#.*/i, // URLs with hash
        /\?s=/i, // Search results
        /\?p=\d+/i, // WordPress pagination
        /\?(utm_|fbclid|gclid)/i, // Tracking parameters
      ],
      useHeadlessBrowser = false,
      headlessBrowserPaths = [],
      checkSitemaps = true,
      useRedisQueue = !!this.redis,
      perDomainDelay = config.crawler.perDomainDelay,
      defaultDelay = config.crawler.defaultDelay,
      userAgent = config.crawler.userAgent,
      followRedirects = true,
      respectRobotsTxt = true,
    } = options;

    // Normalize seed URL
    let normalizedSeedUrl = url;
    if (
      !normalizedSeedUrl.startsWith("http://") &&
      !normalizedSeedUrl.startsWith("https://")
    ) {
      normalizedSeedUrl = "https://" + normalizedSeedUrl;
    }

    const urlProcessor = new UrlProcessor(normalizedSeedUrl);
    normalizedSeedUrl = urlProcessor.normalize(normalizedSeedUrl);

    // Extract the domain from seed URL
    const seedUrlObj = new URL(normalizedSeedUrl);
    const domain = seedUrlObj.hostname;

    // Setup scanners
    const httpScanner = new HttpScanner({ userAgent, timeout });
    const browserScanner = useHeadlessBrowser
      ? new HeadlessBrowser({ userAgent, timeout })
      : null;

    // Initialize state manager
    const stateManager = new CrawlStateManager({
      scanId: this.scanId,
      redisClient: useRedisQueue ? this.redis : null,
      supabase: this.supabase,
    });

    // Initialize queue manager
    const queueManager = new QueueManager(normalizedSeedUrl, {
      scanId: this.scanId,
      redisClient: useRedisQueue ? this.redis : null,
      perDomainDelay,
      defaultDelay,
    });

    // Add seed URL to queue
    await queueManager.addToQueue({
      url: normalizedSeedUrl,
      depth: 0,
      priority: 10, // High priority for seed URL
    });

    // Process robots.txt if enabled
    let robotsData: RobotsData = {
      sitemaps: [],
      allowedPaths: [],
      disallowedPaths: [],
    };

    if (respectRobotsTxt) {
      const robotsParser = new RobotsParser({ userAgent });
      robotsData = await robotsParser.parse(domain);

      // Set crawl delays found in robots.txt
      if (robotsData.crawlDelay) {
        queueManager.setCrawlDelay(domain, robotsData.crawlDelay);
      }
    }

    // Process sitemaps if enabled
    if (checkSitemaps) {
      await this.processSitemaps(domain, queueManager, robotsData.sitemaps);
    }

    // Start the crawl process
    const startTime = Date.now();

    // Create timeout promise
    const timeoutPromise = new Promise<ScanResult[]>((resolve) => {
      setTimeout(() => resolve(stateManager.getPagesScanned()), timeout);
    });

    // Create the crawling promise
    const crawlPromise = this.executeParallelCrawl(
      queueManager,
      stateManager,
      httpScanner,
      browserScanner,
      {
        maxDepth,
        maxPages,
        concurrentRequests,
        excludePatterns,
        headlessBrowserPaths,
        domain,
        timeout,
        startTime,
        robotsData,
        robotsParser: respectRobotsTxt ? new RobotsParser({ userAgent }) : null,
      },
    );

    // Return results, either when crawling completes or timeout is reached
    return Promise.race([crawlPromise, timeoutPromise]);
  }

  /**
   * Processes sitemaps to discover URLs
   * @param domain Domain being crawled
   * @param queueManager Queue manager instance
   * @param robotsSitemaps Sitemaps found in robots.txt
   */
  private async processSitemaps(
    domain: string,
    queueManager: QueueManager,
    robotsSitemaps: string[],
  ): Promise<void> {
    try {
      const sitemapProcessor = new SitemapProcessor();
      const processedSitemaps = new Set<string>();

      // First process sitemaps from robots.txt
      if (robotsSitemaps.length > 0) {
        for (const sitemapUrl of robotsSitemaps) {
          processedSitemaps.add(sitemapUrl);
          const urls = await sitemapProcessor.process(sitemapUrl);

          for (const foundUrl of urls) {
            await queueManager.addToQueue({
              url: new UrlProcessor(foundUrl).normalize(foundUrl),
              depth: 0,
              priority: 8, // Medium-high priority for sitemap URLs
            });
          }
        }
      }

      // Then check common sitemap locations
      const commonSitemapUrls =
        await sitemapProcessor.processCommonLocations(domain);

      for (const foundUrl of commonSitemapUrls) {
        await queueManager.addToQueue({
          url: new UrlProcessor(foundUrl).normalize(foundUrl),
          depth: 0,
          priority: 8,
        });
      }
    } catch (error) {
      console.warn("Error processing sitemaps:", error);
    }
  }

  /**
   * Executes the parallel crawling process
   * @param queueManager Queue manager instance
   * @param stateManager State manager instance
   * @param httpScanner HTTP scanner instance
   * @param browserScanner Browser scanner instance (optional)
   * @param options Crawl execution options
   * @returns Array of scan results
   */
  private async executeParallelCrawl(
    queueManager: QueueManager,
    stateManager: CrawlStateManager,
    httpScanner: HttpScanner,
    browserScanner: HeadlessBrowser | null,
    options: {
      maxDepth: number;
      maxPages: number;
      concurrentRequests: number;
      excludePatterns: RegExp[];
      headlessBrowserPaths: string[];
      domain: string;
      timeout: number;
      startTime: number;
      robotsData: RobotsData;
      robotsParser: RobotsParser | null;
    },
  ): Promise<ScanResult[]> {
    return new Promise<ScanResult[]>(async (resolve) => {
      const {
        maxDepth,
        maxPages,
        concurrentRequests,
        excludePatterns,
        headlessBrowserPaths,
        domain,
        timeout,
        startTime,
        robotsData,
        robotsParser,
      } = options;

      // Array to track active crawler promises
      const activeCrawls = Array(concurrentRequests).fill(false);

      // Recursive function to process the next URL in the queue
      const processNext = async (crawlerId: number) => {
        // Check if we've reached limits
        if (
          (await queueManager.isEmpty()) ||
          (await stateManager.getScannedCount()) >= maxPages ||
          Date.now() - startTime > timeout
        ) {
          activeCrawls[crawlerId] = false;

          // If all crawlers are inactive, resolve the promise
          if (!activeCrawls.some(Boolean)) {
            // Final progress update
            await stateManager.updateProgress();
            resolve(stateManager.getPagesScanned());
          }
          return;
        }

        // Get next URL from queue
        const queueItem = await queueManager.getNextItem();

        if (!queueItem) {
          // No items in queue, try again later
          setTimeout(() => processNext(crawlerId), 100);
          return;
        }

        const { url, depth } = queueItem;

        // Skip if already visited or exceeds max depth
        if ((await stateManager.hasVisited(url)) || depth > maxDepth) {
          // Continue with next URL
          setImmediate(() => processNext(crawlerId));
          return;
        }

        // Check robots.txt if parser is available
        if (robotsParser && robotsData) {
          try {
            const urlObj = new URL(url);
            const path = urlObj.pathname + urlObj.search;

            if (!robotsParser.isPathAllowed(path, robotsData)) {
              console.log(`Skipping ${url} - disallowed by robots.txt`);
              setImmediate(() => processNext(crawlerId));
              return;
            }
          } catch (error) {
            // If URL parsing fails, continue anyway
          }
        }

        // Check against exclude patterns
        const shouldExclude = excludePatterns.some((pattern) =>
          pattern.test(url),
        );
        if (shouldExclude) {
          setImmediate(() => processNext(crawlerId));
          return;
        }

        // Mark as visited and crawler as active
        await stateManager.markVisited(url);
        activeCrawls[crawlerId] = true;

        try {
          // Log progress
          console.log(
            `Crawler ${crawlerId} processing (${
              (await stateManager.getScannedCount()) + 1
            }/${maxPages}): ${url}`,
          );

          // Choose scanning method (headless or regular)
          let result: ScanResult;

          const shouldUseHeadless =
            browserScanner !== null &&
            (headlessBrowserPaths.some((path) => url.includes(path)) ||
              // Use headless for homepage
              new URL(url).pathname === "/" ||
              new URL(url).pathname === "");

          if (shouldUseHeadless && browserScanner) {
            result = await browserScanner.scan(url, depth);
          } else {
            result = await httpScanner.scan(url, depth);
          }

          // Add to results
          await stateManager.addPageScanned(result);

          // Process internal links if under max depth
          if (depth < maxDepth) {
            await this.processInternalLinks(
              result,
              queueManager,
              depth,
              excludePatterns,
            );
          }

          // Update progress periodically
          await stateManager.updateProgress();
        } catch (error) {
          console.error(`Error crawling ${url}:`, error);

          // Retry logic
          const retries = (queueItem.retries || 0) + 1;
          if (retries <= 3) {
            // Maximum 3 retries
            await queueManager.addToQueue({
              ...queueItem,
              retries,
              priority: Math.max(1, (queueItem.priority || 5) - 2), // Lower priority for retries
            });
            console.log(`Scheduled retry ${retries} for: ${url}`);
          }
        }

        // Mark crawler as inactive
        activeCrawls[crawlerId] = false;

        // Process next URL
        setImmediate(() => processNext(crawlerId));
      };

      // Start concurrent crawlers
      for (let i = 0; i < concurrentRequests; i++) {
        processNext(i);
      }
    });
  }

  /**
   * Processes internal links found during crawling
   * @param result Scan result containing links
   * @param queueManager Queue manager instance
   * @param currentDepth Current crawl depth
   * @param excludePatterns Patterns to exclude
   */
  private async processInternalLinks(
    result: ScanResult,
    queueManager: QueueManager,
    currentDepth: number,
    excludePatterns: RegExp[],
  ): Promise<void> {
    const urlProcessor = new UrlProcessor(result.url);

    // Ensure internal_links is defined
    if (!result.internal_links) {
      return;
    }

    for (const link of result.internal_links) {
      try {
        const linkUrl = link.url;

        // Skip already queued URLs
        if (await queueManager.isQueued(linkUrl)) {
          continue;
        }

        // Check against exclude patterns
        const shouldExclude = excludePatterns.some((pattern) =>
          pattern.test(linkUrl),
        );
        if (shouldExclude) {
          continue;
        }

        // Calculate priority based on URL and depth
        const priority = this.calculatePriority(linkUrl, currentDepth);

        // Add to queue
        await queueManager.addToQueue({
          url: linkUrl,
          depth: currentDepth + 1,
          priority,
        });
      } catch (error) {
        // Skip problematic URLs
        continue;
      }
    }
  }

  /**
   * Calculates priority for a URL in the crawl queue
   * @param url URL to calculate priority for
   * @param depth Current depth of the URL
   * @returns Priority value (1-10, higher is more important)
   */
  private calculatePriority(url: string, depth: number): number {
    let priority = 10 - depth; // Higher priority for shallow URLs

    // Higher priority for important paths
    if (
      url.includes("/blog") ||
      url.includes("/article") ||
      url.includes("/post")
    ) {
      priority += 3;
    }

    if (
      url.includes("/product") ||
      url.includes("/category") ||
      url.includes("/service")
    ) {
      priority += 2;
    }

    // Lower priority for paginated pages
    if (url.match(/\/page\/\d+/) || url.match(/page=\d+/)) {
      priority -= 2;
    }

    // Limit range between 1-10
    return Math.min(10, Math.max(1, priority));
  }
}
