import { Redis } from "@upstash/redis";
import { config } from "../../../config";
import { UrlProcessor } from "../utils/url";
import { CrawlerError, ErrorCode } from "../../../utils/error";

/**
 * Queue item representing a URL to crawl
 */
export interface QueueItem {
  url: string;
  depth: number;
  priority: number;
  retries?: number;
  addedAt?: number;
}

/**
 * Options for queue manager
 */
export interface QueueManagerOptions {
  scanId?: string;
  redisClient?: Redis | null;
  perDomainDelay?: number;
  defaultDelay?: number;
}

/**
 * Manages the crawl queue with support for distributed crawling via Redis
 */
export class QueueManager {
  private readonly scanId: string;
  private readonly redis: Redis | null;
  private readonly urlProcessor: UrlProcessor;
  private readonly perDomainDelay: number;
  private readonly defaultDelay: number;

  // In-memory queue for non-Redis mode
  private inMemoryQueue: QueueItem[] = [];
  private inMemoryQueued: Set<string> = new Set();

  // Track last access time for rate limiting
  private lastDomainAccess: Map<string, number> = new Map();
  private crawlDelays: Map<string, number> = new Map();

  /**
   * Creates a new Queue Manager
   * @param baseUrl Base URL for normalization
   * @param options Queue manager options
   */
  constructor(baseUrl: string, options: QueueManagerOptions = {}) {
    this.scanId = options.scanId || "default";
    this.redis = options.redisClient || null;
    this.urlProcessor = new UrlProcessor(baseUrl);
    this.perDomainDelay =
      options.perDomainDelay || config.crawler.perDomainDelay;
    this.defaultDelay = options.defaultDelay || config.crawler.defaultDelay;

    // Set default crawl delay for the main domain
    this.setCrawlDelay(this.urlProcessor.getDomain(), this.perDomainDelay);
  }

  /**
   * Gets Redis queue key
   * @returns Redis key for the queue
   */
  private getQueueKey(): string {
    return `crawler:queue:${this.scanId}`;
  }

  /**
   * Gets Redis set key for tracking queued URLs
   * @returns Redis key for queued set
   */
  private getQueuedSetKey(): string {
    return `crawler:queued:${this.scanId}`;
  }

  /**
   * Adds an item to the queue
   * @param item Queue item to add
   * @throws CrawlerError if adding to queue fails
   */
  async addToQueue(item: QueueItem): Promise<void> {
    try {
      const normalizedUrl = this.urlProcessor.normalize(item.url);

      // Don't add if already queued
      if (await this.isQueued(normalizedUrl)) {
        return;
      }

      // Add to either Redis or in-memory queue
      if (this.redis) {
        await this.addToRedisQueue(normalizedUrl, {
          ...item,
          url: normalizedUrl,
          addedAt: Date.now(),
        });
      } else {
        this.addToInMemoryQueue(normalizedUrl, {
          ...item,
          url: normalizedUrl,
          addedAt: Date.now(),
        });
      }
    } catch (error) {
      throw new CrawlerError(
        `Failed to add URL to queue: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.UNKNOWN_ERROR,
      );
    }
  }

  /**
   * Adds an item to the Redis queue
   * @param normalizedUrl Normalized URL
   * @param item Queue item to add
   */
  private async addToRedisQueue(
    normalizedUrl: string,
    item: QueueItem,
  ): Promise<void> {
    if (!this.redis) return;

    const queueKey = this.getQueueKey();
    const queuedSetKey = this.getQueuedSetKey();

    // Use Redis transaction
    const pipeline = this.redis.pipeline();

    // Add to set of queued URLs
    pipeline.sadd(queuedSetKey, normalizedUrl);

    // Add to priority queue using sorted set
    const priority = item.priority || 5;
    pipeline.zadd(queueKey, { score: priority, member: JSON.stringify(item) });

    // Execute pipeline
    await pipeline.exec();
  }

  /**
   * Adds an item to the in-memory queue
   * @param normalizedUrl Normalized URL
   * @param item Queue item to add
   */
  private addToInMemoryQueue(normalizedUrl: string, item: QueueItem): void {
    // Mark as queued
    this.inMemoryQueued.add(normalizedUrl);

    // Add to queue with priority
    const priority = item.priority || 5;

    // Find insertion point to maintain sorted order (highest priority first)
    const insertIndex = this.inMemoryQueue.findIndex(
      (queueItem) => (queueItem.priority || 5) < priority,
    );

    if (insertIndex === -1) {
      // Add to end if no item with lower priority found
      this.inMemoryQueue.push(item);
    } else {
      // Insert at the appropriate position
      this.inMemoryQueue.splice(insertIndex, 0, item);
    }
  }

  /**
   * Checks if a URL is already queued
   * @param url URL to check
   * @returns True if URL is already queued
   */
  async isQueued(url: string): Promise<boolean> {
    const normalizedUrl = this.urlProcessor.normalize(url);

    if (this.redis) {
      const key = this.getQueuedSetKey();
      return (await this.redis.sismember(key, normalizedUrl)) === 1;
    } else {
      return this.inMemoryQueued.has(normalizedUrl);
    }
  }

  /**
   * Gets the next item from the queue
   * @returns Next item to process or null if queue is empty
   */
  async getNextItem(): Promise<QueueItem | null> {
    if (this.redis) {
      return await this.getNextFromRedisQueue();
    } else {
      return this.getNextFromInMemoryQueue();
    }
  }

  /**
   * Gets the next item from the Redis queue
   * @returns Next item from Redis queue
   */
  private async getNextFromRedisQueue(): Promise<QueueItem | null> {
    if (!this.redis) return null;

    const queueKey = this.getQueueKey();

    // Get the highest priority item (lowest score)
    const results = await this.redis.zrange(queueKey, 0, 0, {
      withScores: true,
    });

    if (!results || results.length === 0) {
      return null;
    }

    // The structure returned by Upstash Redis can vary, so we need to handle different formats
    // Let's examine the first result to determine its structure
    const result = results[0];

    // Determine where the actual data (member) is stored
    let itemJson: string;

    // Check the structure type returned by Redis
    if (typeof result === "object" && result !== null) {
      // For { value: string, score: number } format
      if ("value" in result && typeof result.value === "string") {
        itemJson = result.value;
      }
      // For { member: string, score: number } format
      else if ("member" in result && typeof result.member === "string") {
        itemJson = result.member;
      }
      // For [string, number] format converted to object
      else if ("0" in result && typeof result[0] === "string") {
        itemJson = result[0];
      } else {
        console.warn("Unexpected data format in Redis queue:", result);
        return null;
      }
    }
    // For simple string format
    else if (typeof result === "string") {
      itemJson = result;
    } else {
      console.warn("Unexpected data format in Redis queue:", result);
      return null;
    }

    try {
      const item: QueueItem = JSON.parse(itemJson);

      // Remove from queue
      await this.redis.zrem(queueKey, itemJson);

      // Apply crawl delay if needed
      await this.applyCrawlDelay(item.url);

      return item;
    } catch (error) {
      console.error("Failed to parse queue item from Redis:", error);
      // Remove invalid item from queue to prevent blocking
      await this.redis.zrem(queueKey, itemJson);
      return null;
    }
  }

  /**
   * Gets the next item from the in-memory queue
   * @returns Next item from in-memory queue
   */
  private getNextFromInMemoryQueue(): QueueItem | null {
    if (this.inMemoryQueue.length === 0) {
      return null;
    }

    // Get highest priority item (which is at the front due to our sorted insertion)
    const item = this.inMemoryQueue.shift()!;

    // Apply crawl delay
    this.applyCrawlDelay(item.url);

    return item;
  }

  /**
   * Applies appropriate delay based on domain's rate limit
   * @param url URL to check for delay
   */
  private async applyCrawlDelay(url: string): Promise<void> {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname;

      const now = Date.now();
      const lastAccess = this.lastDomainAccess.get(domain) || 0;
      const timeSinceLastAccess = now - lastAccess;

      // Get appropriate delay for this domain
      const delay = this.getCrawlDelay(domain);

      // If we need to wait, do so
      if (timeSinceLastAccess < delay) {
        const waitTime = delay - timeSinceLastAccess;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Update last access time
      this.lastDomainAccess.set(domain, Date.now());
    } catch (error) {
      // If URL parsing fails, just continue
      console.warn(`Error applying crawl delay for ${url}:`, error);
    }
  }

  /**
   * Checks if the queue is empty
   * @returns True if queue is empty
   */
  async isEmpty(): Promise<boolean> {
    if (this.redis) {
      const queueKey = this.getQueueKey();
      return (await this.redis.zcard(queueKey)) === 0;
    } else {
      return this.inMemoryQueue.length === 0;
    }
  }

  /**
   * Sets crawl delay for a specific domain
   * @param domain Domain to set delay for
   * @param delayMs Delay in milliseconds
   */
  setCrawlDelay(domain: string, delayMs: number): void {
    this.crawlDelays.set(domain, delayMs);
  }

  /**
   * Gets crawl delay for a specific domain
   * @param domain Domain to get delay for
   * @returns Delay in milliseconds
   */
  getCrawlDelay(domain: string): number {
    return this.crawlDelays.get(domain) || this.defaultDelay;
  }

  /**
   * Clears all queues (for cleanup)
   */
  async clear(): Promise<void> {
    if (this.redis) {
      const queueKey = this.getQueueKey();
      const queuedSetKey = this.getQueuedSetKey();

      await this.redis.del(queueKey);
      await this.redis.del(queuedSetKey);
    } else {
      this.inMemoryQueue = [];
      this.inMemoryQueued.clear();
    }

    // Reset domain access tracking
    this.lastDomainAccess.clear();
  }

  /**
   * Gets the size of the queue
   * @returns Number of items in queue
   */
  async getQueueSize(): Promise<number> {
    if (this.redis) {
      const queueKey = this.getQueueKey();
      return await this.redis.zcard(queueKey);
    } else {
      return this.inMemoryQueue.length;
    }
  }
}
