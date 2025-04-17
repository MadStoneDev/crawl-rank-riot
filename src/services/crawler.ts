import { scanWebsite } from "./scan";

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
    let activeCrawls = 0;

    const processNext = async () => {
      // Check if we've reached limits
      if (
        queue.length === 0 ||
        pagesScanned.length >= maxPages ||
        Date.now() - startTime > timeout
      ) {
        if (activeCrawls === 0) {
          resolve(pagesScanned);
        }
        return;
      }

      // Get next URL from queue
      const { url, depth } = queue.shift()!;

      // Skip if already visited or exceeds max depth
      if (urlsVisited.has(url) || depth > maxDepth) {
        processNext();
        return;
      }

      // Mark as visited
      urlsVisited.add(url);
      activeCrawls++;

      try {
        // Scan the page
        console.log(
          `Crawling (${pagesScanned.length + 1}/${maxPages}): ${url}`,
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

      // Decrement active crawls
      activeCrawls--;

      // Process next URL
      processNext();
    };

    // Start concurrent crawlers
    const concurrentPromises = [];
    for (let i = 0; i < concurrentRequests; i++) {
      concurrentPromises.push(processNext());
    }
  });

  // Return results, either when crawling completes or timeout is reached
  return Promise.race([crawlPromise, timeoutPromise]);
}

// Example usage:
// crawlWebsite("example.com", { maxDepth: 3, maxPages: 100 })
//   .then(results => console.log(`Crawled ${results.length} pages`))
//   .catch(error => console.error("Crawl failed:", error));
