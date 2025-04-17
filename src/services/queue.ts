import logger from "../utils/logger";
import { QueueItem } from "../types";

/**
 * A simple queue implementation that doesn't rely on external packages
 * This avoids the ESM compatibility issues with p-queue
 */
class CrawlQueue {
  private _size: number = 0;
  private _pending: number = 0;
  private concurrency: number = 3;
  private running: number = 0;
  private queue: Array<{ item: QueueItem; executor: Function }> = [];
  private urlsInQueue: Set<string> = new Set();
  private urlsSeen: Set<string> = new Set();

  constructor(concurrency: number = 3) {
    this.concurrency = concurrency;
    logger.debug(`Queue initialized with concurrency ${concurrency}`);
  }

  // Add a URL to the queue
  async add(
    item: QueueItem,
    executor: (item: QueueItem) => Promise<void>,
  ): Promise<void> {
    try {
      const normalizedUrl = this.normalizeUrl(item.url);

      if (
        this.urlsSeen.has(normalizedUrl) ||
        this.urlsInQueue.has(normalizedUrl)
      ) {
        return;
      }

      this.urlsInQueue.add(normalizedUrl);
      this.urlsSeen.add(normalizedUrl);

      // Add to internal queue
      this.queue.push({ item, executor });
      this._size++;

      // Process queue immediately
      this.processQueue();
    } catch (error) {
      logger.error(`Error adding item to queue: ${error}`);
      try {
        // Directly execute if queue fails
        await executor(item);
      } catch (execError) {
        logger.error(`Error executing task directly: ${execError}`);
      }
    }
  }

  private async processQueue(): Promise<void> {
    // Process as many items as we can according to concurrency limit
    while (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;

      this.running++;
      this._size--;
      this._pending++;

      const { item, executor } = next;
      const normalizedUrl = this.normalizeUrl(item.url);

      try {
        // Execute the task
        await executor(item);
      } catch (error) {
        if (error instanceof Error) {
          logger.error(`Error processing URL ${item.url}: ${error.message}`);
        } else {
          logger.error(`Unknown error processing URL ${item.url}`);
        }
      } finally {
        // Remove from tracking and process next
        this.urlsInQueue.delete(normalizedUrl);
        this.running--;
        this._pending--;
        this.processQueue();
      }
    }

    // If all items are processed, emit an "idle" event
    if (this.running === 0 && this.queue.length === 0) {
      logger.debug("Queue is idle");
    }
  }

  // Normalize URL to avoid duplicates
  private normalizeUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);

      // Remove trailing slash if it's the only path
      if (parsedUrl.pathname === "/") {
        parsedUrl.pathname = "";
      }

      // Remove common tracking parameters
      parsedUrl.searchParams.delete("utm_source");
      parsedUrl.searchParams.delete("utm_medium");
      parsedUrl.searchParams.delete("utm_campaign");

      return parsedUrl.toString();
    } catch (error) {
      // If URL parsing fails, return the original
      return url;
    }
  }

  // Get queue size
  get size(): number {
    return this._size;
  }

  // Get pending count
  get pending(): number {
    return this._pending;
  }

  // Check if a URL has been seen
  hasSeen(url: string): boolean {
    return this.urlsSeen.has(this.normalizeUrl(url));
  }

  // Clear queue and tracking sets
  async clear(): Promise<void> {
    try {
      logger.debug("Clearing queue and tracking sets");
      this.queue = [];
      this._size = 0;
      this.urlsInQueue.clear();
      this.urlsSeen.clear();
      logger.debug("Queue and tracking sets cleared successfully");
    } catch (error) {
      logger.error(`Error clearing queue: ${error}`);
      // Initialize empty arrays/sets if clearing fails
      this.queue = [];
      this._size = 0;
      this.urlsInQueue = new Set();
      this.urlsSeen = new Set();
    }
  }

  // Pause queue (implementation is a no-op for simplicity)
  async pause(): Promise<void> {
    logger.debug("Queue pause requested (not implemented in simplified queue)");
  }

  // Resume queue (implementation is a no-op for simplicity)
  async resume(): Promise<void> {
    logger.debug(
      "Queue resume requested (not implemented in simplified queue)",
    );
    // Just process the queue again
    this.processQueue();
  }
}

export default CrawlQueue;
