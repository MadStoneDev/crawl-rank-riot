﻿import { scanWebsite } from "./scan";

// Import the normalizeUrl function from scanWebsite or define it here
function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);

    // Convert to lowercase
    let normalized = `${urlObj.protocol}//${urlObj.hostname.toLowerCase()}${
      urlObj.pathname
    }`;

    // Remove trailing slash for non-root paths
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    // Keep the query params if they exist
    if (urlObj.search) {
      normalized += urlObj.search;
    }

    return normalized;
  } catch (error) {
    return url; // Return original if parsing fails
  }
}

interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  concurrentRequests?: number;
  timeout?: number;
  excludePatterns?: RegExp[];
}

export async function crawlWebsite(
  seedUrl: string,
  options: CrawlOptions = {},
): Promise<any[]> {
  const {
    maxDepth = 10,
    maxPages = 1000,
    concurrentRequests = 5,
    timeout = 120000, // 2 minutes
    excludePatterns = [
      // Common patterns to exclude
      /\.(jpg|jpeg|png|gif|svg|webp|pdf|doc|docx|xls|xlsx|zip|tar)$/i,
      /\/(wp-admin|wp-includes|wp-content\/plugins)\//i,
      /#.*/i, // URLs with hash
      /\?s=/i, // Search results
      /\?p=\d+/i, // WordPress pagination
      /\?(utm_|fbclid|gclid)/i, // Tracking parameters
    ],
  } = options;

  // Normalize seed URL
  let normalizedSeedUrl = seedUrl;
  if (
    !normalizedSeedUrl.startsWith("http://") &&
    !normalizedSeedUrl.startsWith("https://")
  ) {
    normalizedSeedUrl = "https://" + normalizedSeedUrl;
  }

  normalizedSeedUrl = normalizeUrl(normalizedSeedUrl);

  // Extract the domain from seed URL
  const seedUrlObj = new URL(normalizedSeedUrl);
  const domain = seedUrlObj.hostname;

  // Initialize tracking variables
  const pagesScanned: any[] = []; // Results array
  const urlsQueued = new Set<string>(); // Track queued URLs
  const urlsVisited = new Set<string>(); // Track visited URLs
  const queue: { url: string; depth: number }[] = []; // URL queue with depth

  // Add seed URL to queue
  queue.push({ url: normalizedSeedUrl, depth: 0 });
  urlsQueued.add(normalizedSeedUrl);

  // Process queue with concurrency limit
  const startTime = Date.now();
  const timeoutPromise = new Promise<any[]>((resolve) => {
    setTimeout(() => resolve(pagesScanned), timeout);
  });

  // Create the crawling promise
  const crawlPromise = new Promise<any[]>(async (resolve) => {
    const activeCrawls = Array(concurrentRequests).fill(false);

    const processNext = async (crawlerId: number) => {
      // Check if we've reached limits
      if (
        queue.length === 0 ||
        pagesScanned.length >= maxPages ||
        Date.now() - startTime > timeout
      ) {
        activeCrawls[crawlerId] = false;

        // If all crawlers are inactive, resolve the promise
        if (!activeCrawls.some(Boolean)) {
          resolve(pagesScanned);
        }
        return;
      }

      // Get next URL from queue
      const { url, depth } = queue.shift()!;

      // Skip if already visited or exceeds max depth
      if (urlsVisited.has(url) || depth > maxDepth) {
        // Continue with next URL
        setImmediate(() => processNext(crawlerId));
        return;
      }

      // Mark as visited and crawler as active
      urlsVisited.add(url);
      activeCrawls[crawlerId] = true;

      try {
        // Scan the page
        console.log(
          `Crawler ${crawlerId} processing (${
            pagesScanned.length + 1
          }/${maxPages}): ${url}`,
        );
        const result = await scanWebsite(url, depth);

        // Add to results
        pagesScanned.push(result);

        // Process internal links
        if (depth < maxDepth) {
          for (const link of result.internal_links) {
            const linkUrl = link.url;

            // Skip already queued URLs
            if (urlsQueued.has(linkUrl) || urlsVisited.has(linkUrl)) {
              continue;
            }

            // Check against exclude patterns
            const shouldExclude = excludePatterns.some((pattern) =>
              pattern.test(linkUrl),
            );
            if (shouldExclude) {
              continue;
            }

            // Add to queue
            queue.push({ url: linkUrl, depth: depth + 1 });
            urlsQueued.add(linkUrl);
          }
        }
      } catch (error) {
        console.error(`Error crawling ${url}:`, error);
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

  // Return results, either when crawling completes or timeout is reached
  return Promise.race([crawlPromise, timeoutPromise]);
}

// Example usage:
// crawlWebsite("example.com", { maxDepth: 3, maxPages: 100 })
//   .then(results => console.log(`Crawled ${results.length} pages`))
//   .catch(error => console.error("Crawl failed:", error));
