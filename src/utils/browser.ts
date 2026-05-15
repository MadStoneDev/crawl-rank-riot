import puppeteer, { Browser } from "puppeteer";

/**
 * Check if a URL belongs to a JavaScript-heavy platform
 * that requires headless browser rendering for proper scanning.
 */
export function isJavaScriptHeavySite(url: string): boolean {
  const jsHeavyPlatforms = [
    "shopify.com",
    "shopifypreview.com",
    "myshopify.com",
    "squarespace.com",
    "wix.com",
    "webflow.io",
    "bigcommerce.com",
    "magento.com",
  ];

  const lowerUrl = url.toLowerCase();
  return jsHeavyPlatforms.some((platform) => lowerUrl.includes(platform));
}

const BROWSER_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-features=VizDisplayCompositor",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

/**
 * Shared browser pool. Reuses a single Puppeteer browser instance
 * instead of launching a new Chrome process per page scan.
 * Callers acquire the browser, create a page, scan, close the page.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private pageCount = 0;

  async acquire(): Promise<Browser> {
    if (this.browser && this.browser.connected) {
      this.pageCount++;
      return this.browser;
    }

    if (this.launching) {
      const browser = await this.launching;
      this.pageCount++;
      return browser;
    }

    this.launching = puppeteer.launch({
      headless: true,
      args: BROWSER_LAUNCH_ARGS,
    });

    try {
      this.browser = await this.launching;
      this.pageCount = 1;
      return this.browser;
    } finally {
      this.launching = null;
    }
  }

  release(): void {
    this.pageCount = Math.max(0, this.pageCount - 1);
  }

  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Browser may already be closed
      }
      this.browser = null;
      this.pageCount = 0;
    }
  }
}

let sharedPool: BrowserPool | null = null;

export function getSharedBrowserPool(): BrowserPool {
  if (!sharedPool) {
    sharedPool = new BrowserPool();
  }
  return sharedPool;
}

export async function closeSharedBrowserPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.close();
    sharedPool = null;
  }
}
