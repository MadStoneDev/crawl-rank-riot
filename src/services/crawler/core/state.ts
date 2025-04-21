import { Redis } from "@upstash/redis";
import { SupabaseClient } from "@supabase/supabase-js";
import { ScanResult } from "../../../types/common";
import { CrawlerError, ErrorCode } from "../../../utils/error";

/**
 * Options for the CrawlStateManager
 */
export interface StateManagerOptions {
  scanId?: string;
  redisClient?: Redis | null;
  supabase?: SupabaseClient | null;
  progressUpdateInterval?: number;
}

/**
 * Manages crawler state during a crawl operation
 * Handles tracking visited URLs, storing results, and updating progress
 */
export class CrawlStateManager {
  private readonly scanId: string;
  private readonly redis: Redis | null;
  private readonly supabase: SupabaseClient | null;
  private readonly progressUpdateInterval: number;

  private pagesScanned: ScanResult[] = [];
  private inMemoryVisited: Set<string> = new Set();
  private lastUpdateTime = 0;

  /**
   * Creates a new crawl state manager
   * @param options State manager options
   */
  constructor(options: StateManagerOptions = {}) {
    this.scanId = options.scanId || "default";
    this.redis = options.redisClient || null;
    this.supabase = options.supabase || null;
    this.progressUpdateInterval = options.progressUpdateInterval || 2000; // Default 2 seconds
  }

  /**
   * Gets the Redis key for visited URLs
   * @returns Redis key for visited URLs
   */
  private getVisitedKey(): string {
    return `crawler:visited:${this.scanId}`;
  }

  /**
   * Gets the Redis key for scan results
   * @returns Redis key for scan results
   */
  private getResultsKey(): string {
    return `crawler:results:${this.scanId}`;
  }

  /**
   * Checks if a URL has already been visited
   * @param url URL to check
   * @returns True if URL has been visited
   */
  async hasVisited(url: string): Promise<boolean> {
    if (this.redis) {
      const visitedKey = this.getVisitedKey();
      return (await this.redis.sismember(visitedKey, url)) === 1;
    } else {
      return this.inMemoryVisited.has(url);
    }
  }

  /**
   * Marks a URL as visited
   * @param url URL to mark as visited
   */
  async markVisited(url: string): Promise<void> {
    if (this.redis) {
      const visitedKey = this.getVisitedKey();
      await this.redis.sadd(visitedKey, url);
    } else {
      this.inMemoryVisited.add(url);
    }
  }

  /**
   * Adds a scanned page to results
   * @param result Scan result to add
   */
  async addPageScanned(result: ScanResult): Promise<void> {
    // Add timestamp if not present
    if (!result.scanned_at) {
      result.scanned_at = new Date().toISOString();
    }

    if (this.redis && this.scanId) {
      // Store in Redis for distributed crawling
      const resultsKey = this.getResultsKey();
      await this.redis.lpush(resultsKey, JSON.stringify(result));
    } else {
      // Store in memory
      this.pagesScanned.push(result);
    }
  }

  /**
   * Gets count of pages scanned
   * @returns Number of pages scanned
   */
  async getScannedCount(): Promise<number> {
    if (this.redis && this.scanId) {
      const resultsKey = this.getResultsKey();
      return await this.redis.llen(resultsKey);
    } else {
      return this.pagesScanned.length;
    }
  }

  /**
   * Gets all scanned pages
   * @returns Array of scan results
   */
  getPagesScanned(): ScanResult[] {
    return this.pagesScanned;
  }

  /**
   * Updates progress in the database
   */
  async updateProgress(): Promise<void> {
    const currentTime = Date.now();

    // Only update if enough time has passed
    if (currentTime - this.lastUpdateTime < this.progressUpdateInterval) {
      return;
    }

    this.lastUpdateTime = currentTime;

    if (this.supabase && this.scanId) {
      try {
        // Count links and issues
        let totalInternalLinks = 0;
        let totalExternalLinks = 0;
        let issuesFound = 0;

        for (const page of this.pagesScanned) {
          totalInternalLinks += page.internal_links.length;
          totalExternalLinks += page.external_links.length;

          // Count errors and warnings as issues
          issuesFound +=
            (page.errors?.length || 0) + (page.warnings?.length || 0);
        }

        await this.supabase
          .from("scans")
          .update({
            pages_scanned: await this.getScannedCount(),
            links_scanned: totalInternalLinks + totalExternalLinks,
            issues_found: issuesFound,
            last_progress_update: new Date().toISOString(),
          })
          .eq("id", this.scanId);
      } catch (error) {
        console.error("Error updating scan progress:", error);
      }
    }
  }

  /**
   * Loads persisted results from Redis (for distributed crawling)
   * @returns Array of scan results
   */
  async loadResults(): Promise<ScanResult[]> {
    if (this.redis && this.scanId) {
      try {
        const resultsKey = this.getResultsKey();
        const results = await this.redis.lrange(resultsKey, 0, -1);

        this.pagesScanned = results.map((r: string) => JSON.parse(r));
      } catch (error) {
        throw new CrawlerError(
          `Failed to load results from Redis: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ErrorCode.UNKNOWN_ERROR,
        );
      }
    }

    return this.pagesScanned;
  }

  /**
   * Clears all state (for cleanup)
   */
  async clear(): Promise<void> {
    if (this.redis) {
      const visitedKey = this.getVisitedKey();
      const resultsKey = this.getResultsKey();

      await this.redis.del(visitedKey);
      await this.redis.del(resultsKey);
    }

    this.pagesScanned = [];
    this.inMemoryVisited.clear();
    this.lastUpdateTime = 0;
  }
}
