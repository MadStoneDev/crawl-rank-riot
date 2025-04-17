import logger from "../utils/logger";
import { QueueItem } from "../types";

// Use dynamic import for p-queue
const importPQueue = async () => {
  const module = await import("p-queue");
  return module.default;
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
      // Import PQueue dynamically
      const PQueueModule = await importPQueue();

      // Create a single instance of the queue
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
    if (!this.initialized) {
      logger.debug("Waiting for queue initialization...");
      await this.initPromise;
      logger.debug("Queue initialization complete");
    }
  }

  // Add a URL to the queue
  async add(
    item: QueueItem,
    executor: (item: QueueItem) => Promise<void>,
  ): Promise<void> {
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
    return this.queue?.size || 0;
  }

  // Get pending count
  get pending(): number {
    return this.queue?.pending || 0;
  }

  // Check if a URL has been seen
  hasSeen(url: string): boolean {
    return this.urlsSeen.has(this.normalizeUrl(url));
  }

  // Clear queue and tracking sets
  async clear(): Promise<void> {
    await this.ensureInitialized();

    if (this.queue) {
      this.queue.clear();
    }

    this.urlsInQueue.clear();
    this.urlsSeen.clear();
  }

  // Pause queue
  async pause(): Promise<void> {
    await this.ensureInitialized();
    if (this.queue) {
      this.queue.pause();
    }
  }

  // Resume queue
  async resume(): Promise<void> {
    await this.ensureInitialized();
    if (this.queue) {
      this.queue.start();
    }
  }
}

export default CrawlQueue;
