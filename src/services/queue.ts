import logger from "../utils/logger";

import { QueueItem } from "../types";

let PQueue: any;

const importPQueue = async () => {
  const module = await import("p-queue");
  PQueue = module.default;
};

// Initialize PQueue before using it
class CrawlQueue {
  private queue: any;
  private initialized: boolean = false;
  private urlsInQueue: Set<string> = new Set();
  private urlsSeen: Set<string> = new Set();

  constructor(concurrency: number = 3) {
    this.initializeQueue(concurrency);
  }

  private async initializeQueue(concurrency: number): Promise<void> {
    if (!PQueue) {
      await importPQueue();
    }

    this.queue = new PQueue({ concurrency });
    this.initialized = true;

    // Log when queue is idle
    this.queue.on("idle", () => {
      console.log("Queue is idle");
    });
  }

  // Make sure queue is initialized before using it
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.initialized) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
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
    return this.queue.size;
  }

  // Get pending count
  get pending(): number {
    return this.queue.pending;
  }

  // Check if a URL has been seen
  hasSeen(url: string): boolean {
    return this.urlsSeen.has(this.normalizeUrl(url));
  }

  // Clear queue and tracking sets
  clear(): void {
    this.queue.clear();
    this.urlsInQueue.clear();
    this.urlsSeen.clear();
  }

  // Pause queue
  pause(): void {
    this.queue.pause();
  }

  // Resume queue
  resume(): void {
    this.queue.start();
  }
}

export default CrawlQueue;
