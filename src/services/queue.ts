import PQueue from "p-queue";
import logger from "../utils/logger";
import { QueueItem } from "../types";

// Create a singleton queue that can be used across the application
class CrawlQueue {
  private queue: PQueue;
  private urlsInQueue: Set<string> = new Set();
  private urlsSeen: Set<string> = new Set();

  constructor(concurrency: number = 3) {
    this.queue = new PQueue({ concurrency });

    // Log when queue is idle
    this.queue.on("idle", () => {
      logger.info("Queue is idle");
    });
  }

  // Add a URL to the queue
  async add(
    item: QueueItem,
    executor: (item: QueueItem) => Promise<void>,
  ): Promise<void> {
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
