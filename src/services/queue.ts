import logger from "../utils/logger";
import { QueueItem } from "../types";

// Use dynamic import for p-queue with proper error handling
const importPQueue = async () => {
  try {
    // Dynamic import (ESM compatible approach)
    const module = await import("p-queue");
    return module.default;
  } catch (error) {
    logger.error(`Error importing p-queue: ${error}`);
    throw error;
  }
};

class CrawlQueue {
  private queue: any = null;
  private initialized: boolean = false;
  private urlsInQueue: Set<string> = new Set();
  private urlsSeen: Set<string> = new Set();
  private initPromise: Promise<void> | null = null;

  constructor(concurrency: number = 3) {
    // Start initialization immediately but don't wait for it
    this.initPromise = this.initializeQueue(concurrency);
  }

  private async initializeQueue(concurrency: number): Promise<void> {
    try {
      // Import PQueue dynamically to handle ESM module
      const PQueueModule = await importPQueue();

      // Create a new queue instance with the specified concurrency
      this.queue = new PQueueModule({ concurrency });

      // Set up event listeners
      this.queue.on("idle", () => {
        logger.debug("Queue is idle");
      });

      this.initialized = true;
      logger.debug("Queue initialized successfully");
    } catch (error) {
      logger.error(`Failed to initialize queue: ${error}`);
      throw error;
    }
  }

  // Make sure queue is initialized before using it
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized && this.initPromise) {
      logger.debug("Waiting for queue initialization...");
      await this.initPromise;
      logger.debug("Queue initialization complete");
    }

    if (!this.queue) {
      throw new Error("Queue failed to initialize properly");
    }
  }

  // Add a URL to the queue
  async add(
    item: QueueItem,
    executor: (item: QueueItem) => Promise<void>,
  ): Promise<void> {
    try {
      await this.ensureInitialized();

      const normalizedUrl = this.normalizeUrl(item.url);

      if (
        this.urlsSeen.has(normalizedUrl) ||
        this.urlsInQueue.has(normalizedUrl)
      ) {
        return;
      }

      this.urlsInQueue.add(normalizedUrl);
      this.urlsSeen.add(normalizedUrl);

      const priority = item.priority || 0;
      await this.queue.add(() => this.executeTask(item, executor), {
        priority: -priority,
      });
    } catch (error) {
      logger.error(`Error adding item to queue: ${error}`);
      // Directly execute the task if queue fails
      try {
        await executor(item);
      } catch (execError) {
        logger.error(`Error executing task directly: ${execError}`);
      }
    }
  }

  private async executeTask(
    item: QueueItem,
    executor: (item: QueueItem) => Promise<void>,
  ): Promise<void> {
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
      // Remove from in-progress tracking
      this.urlsInQueue.delete(normalizedUrl);
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
    if (!this.queue) return 0;
    return this.queue.size || 0;
  }

  // Get pending count
  get pending(): number {
    if (!this.queue) return 0;
    return this.queue.pending || 0;
  }

  // Check if a URL has been seen
  hasSeen(url: string): boolean {
    return this.urlsSeen.has(this.normalizeUrl(url));
  }

  // Clear queue and tracking sets
  async clear(): Promise<void> {
    try {
      if (!this.initialized) {
        // If not initialized, just create new sets
        this.urlsInQueue = new Set();
        this.urlsSeen = new Set();
        return;
      }

      await this.ensureInitialized();

      logger.debug("Clearing queue and tracking sets");
      if (this.queue && typeof this.queue.clear === "function") {
        this.queue.clear();
      } else {
        logger.warn("Queue clear method not available, creating new queue");
        const concurrency = 3; // Default concurrency
        this.initPromise = this.initializeQueue(concurrency);
      }

      this.urlsInQueue.clear();
      this.urlsSeen.clear();
      logger.debug("Queue and tracking sets cleared successfully");
    } catch (error) {
      logger.error(`Error clearing queue: ${error}`);
      // Initialize empty sets if the queue isn't available
      this.urlsInQueue = new Set();
      this.urlsSeen = new Set();
    }
  }

  // Pause queue
  async pause(): Promise<void> {
    try {
      if (!this.initialized || !this.queue) return;

      await this.ensureInitialized();
      if (typeof this.queue.pause === "function") {
        this.queue.pause();
        logger.debug("Queue paused");
      }
    } catch (error) {
      logger.error(`Error pausing queue: ${error}`);
    }
  }

  // Resume queue
  async resume(): Promise<void> {
    try {
      if (!this.initialized || !this.queue) return;

      await this.ensureInitialized();
      if (typeof this.queue.start === "function") {
        this.queue.start();
        logger.debug("Queue resumed");
      }
    } catch (error) {
      logger.error(`Error resuming queue: ${error}`);
    }
  }
}

export default CrawlQueue;
