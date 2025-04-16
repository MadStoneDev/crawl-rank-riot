"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../utils/logger"));
let PQueue;
const importPQueue = async () => {
    const module = await Promise.resolve().then(() => __importStar(require("p-queue")));
    PQueue = module.default;
};
// Initialize PQueue before using it
class CrawlQueue {
    constructor(concurrency = 3) {
        this.initialized = false;
        this.urlsInQueue = new Set();
        this.urlsSeen = new Set();
        this.initializeQueue(concurrency);
    }
    async initializeQueue(concurrency) {
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
    async ensureInitialized() {
        if (!this.initialized) {
            await new Promise((resolve) => {
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
    async add(item, executor) {
        await this.ensureInitialized();
        const normalizedUrl = this.normalizeUrl(item.url);
        if (this.urlsSeen.has(normalizedUrl) ||
            this.urlsInQueue.has(normalizedUrl)) {
            return;
        }
        this.urlsInQueue.add(normalizedUrl);
        this.urlsSeen.add(normalizedUrl);
        const priority = item.priority || 0;
        await this.queue.add(() => this.executeTask(item, executor), {
            priority: -priority,
        });
    }
    async executeTask(item, executor) {
        const normalizedUrl = this.normalizeUrl(item.url);
        try {
            // Execute the task
            await executor(item);
        }
        catch (error) {
            if (error instanceof Error) {
                logger_1.default.error(`Error processing URL ${item.url}: ${error.message}`);
            }
            else {
                logger_1.default.error(`Unknown error processing URL ${item.url}`);
            }
        }
        finally {
            // Remove from in-progress tracking
            this.urlsInQueue.delete(normalizedUrl);
        }
    }
    // Normalize URL to avoid duplicates
    normalizeUrl(url) {
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
        }
        catch (error) {
            // If URL parsing fails, return the original
            return url;
        }
    }
    // Get queue size
    get size() {
        return this.queue.size;
    }
    // Get pending count
    get pending() {
        return this.queue.pending;
    }
    // Check if a URL has been seen
    hasSeen(url) {
        return this.urlsSeen.has(this.normalizeUrl(url));
    }
    // Clear queue and tracking sets
    clear() {
        this.queue.clear();
        this.urlsInQueue.clear();
        this.urlsSeen.clear();
    }
    // Pause queue
    pause() {
        this.queue.pause();
    }
    // Resume queue
    resume() {
        this.queue.start();
    }
}
exports.default = CrawlQueue;
