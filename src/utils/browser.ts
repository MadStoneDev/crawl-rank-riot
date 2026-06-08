import puppeteer, { Browser } from "puppeteer";
import { getPuppeteerProxyArgs } from "./proxy";

const JS_HEAVY_DOMAINS = [
  "shopify.com",
  "shopifypreview.com",
  "myshopify.com",
  "squarespace.com",
  "squarespace-cdn.com",
  "wix.com",
  "wixsite.com",
  "wixstatic.com",
  "webflow.io",
  "webflow.com",
  "bigcommerce.com",
  "mybigcommerce.com",
  "magento.com",
  "magento.cloud",
  "volusion.com",
  "3dcart.com",
  "shift4shop.com",
  "ecwid.com",
  "weebly.com",
  "godaddysites.com",
  "duda.co",
  "dudaone.com",
  "framer.app",
  "framer.website",
  "carrd.co",
  "bubble.io",
  "softr.io",
  "gatsbyjs.io",
  "vercel.app",
  "netlify.app",
  "cargo.site",
];

/**
 * Check if a URL belongs to a known JS-heavy platform by domain.
 * This is the fast pre-scan check — catches known hosted domains
 * but misses custom domains (e.g. hamblepatch.com on Shopify).
 */
export function isJavaScriptHeavySite(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return JS_HEAVY_DOMAINS.some((domain) => lowerUrl.includes(domain));
}

/**
 * Detect JS-heavy platforms from HTTP response headers.
 * Catches custom domains that isJavaScriptHeavySite misses.
 */
export function detectPlatformFromHeaders(headers: Headers): string | null {
  const poweredBy = (headers.get("powered-by") || headers.get("x-powered-by") || "").toLowerCase();
  const server = (headers.get("server") || "").toLowerCase();
  const via = (headers.get("via") || "").toLowerCase();

  if (poweredBy.includes("shopify") || headers.get("x-shopid") || headers.get("x-shardid")) return "shopify";
  if (poweredBy.includes("squarespace") || server.includes("squarespace")) return "squarespace";
  if (headers.get("x-wix-request-id") || server.includes("wix")) return "wix";
  if (poweredBy.includes("webflow") || server.includes("webflow")) return "webflow";
  if (poweredBy.includes("bigcommerce") || headers.get("x-bc-store-version")) return "bigcommerce";
  if (server.includes("magento") || headers.get("x-magento-vary")) return "magento";
  if (poweredBy.includes("wp engine") || poweredBy.includes("wordpress")) return "wordpress";
  if (headers.get("x-drupal-cache") || headers.get("x-generator")?.toLowerCase().includes("drupal")) return "drupal";
  if (via.includes("varnish") && headers.get("x-cache")) return "varnish-cdn";
  if (poweredBy.includes("next.js")) return "nextjs";
  if (poweredBy.includes("nuxt") || headers.get("x-nuxt-cache")) return "nuxt";

  // Check for Shopify CDN patterns in Link header
  const link = headers.get("link") || "";
  if (link.includes("cdn.shopify.com")) return "shopify";

  // Check for Shopify cookies
  const setCookie = headers.get("set-cookie") || "";
  if (setCookie.includes("_shopify_")) return "shopify";

  return null;
}

const PLATFORMS_NEEDING_HEADLESS = new Set([
  "shopify", "squarespace", "wix", "webflow",
  "bigcommerce", "magento", "nuxt",
]);

/**
 * Detect JS-heavy platform signatures in HTML content.
 * Runs after HTTP fetch on the raw HTML to catch SPAs and
 * JS-rendered sites that the header check missed.
 */
export function detectPlatformFromHtml(html: string): string | null {
  const lower = html.substring(0, 50_000).toLowerCase();

  // SPA frameworks — almost no content without JS
  if (lower.includes('<div id="app"></div>') || lower.includes('<div id="__nuxt">')) return "nuxt";
  if (lower.includes('<div id="__next">') || lower.includes('_next/static')) return "nextjs";
  if (lower.includes('<div id="root"></div>') && lower.includes('bundle.js')) return "react-spa";
  if (lower.includes('<app-root') || lower.includes('ng-version=')) return "angular";

  // Shopify (custom domains)
  if (lower.includes('shopify.com/s/') || lower.includes('cdn.shopify.com') || lower.includes('shopify-section')) return "shopify";
  if (lower.includes('data-shopify') || lower.includes('shopify.loadfeatures')) return "shopify";

  // Squarespace
  if (lower.includes('squarespace.com') || lower.includes('data-squarespace-cacheversion')) return "squarespace";
  if (lower.includes('sqs-block') || lower.includes('sqsp-')) return "squarespace";

  // Wix
  if (lower.includes('static.wixstatic.com') || lower.includes('wix-dropdown')) return "wix";
  if (lower.includes('x-wix-') || lower.includes('corvid-by-wix')) return "wix";

  // Webflow
  if (lower.includes('webflow.com') || lower.includes('data-wf-') || lower.includes('w-nav')) return "webflow";

  // BigCommerce
  if (lower.includes('bigcommerce.com') || lower.includes('data-content-region')) return "bigcommerce";

  // Magento — require multiple signals to avoid false positives (e.g. "mage/" in image paths)
  if (
    (lower.includes('requirejs-config') && lower.includes('mage/')) ||
    lower.includes('magento') ||
    lower.includes('data-mage-init')
  ) return "magento";

  // WordPress + heavy JS themes
  if (lower.includes('wp-content/') || lower.includes('wp-includes/')) return "wordpress";

  // Gatsby / React SSG
  if (lower.includes('___gatsby') || lower.includes('gatsby-')) return "gatsby";

  // Generic SPA indicators — body is empty or has a single mount point
  const bodyMatch = html.match(/<body[^>]*>([\s\S]{0,500})/i);
  if (bodyMatch) {
    const bodyStart = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim();
    if (bodyStart.length < 20) return "spa-generic";
  }

  return null;
}

/**
 * Given a detected platform, should we use headless rendering?
 * Some platforms (WordPress, Gatsby) are usually fine with HTTP scanning
 * because they server-render. SPAs and Shopify always need headless.
 */
export function platformNeedsHeadless(platform: string | null): boolean {
  if (!platform) return false;
  return PLATFORMS_NEEDING_HEADLESS.has(platform) || platform.endsWith("-spa") || platform === "spa-generic";
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
      args: [...BROWSER_LAUNCH_ARGS, ...getPuppeteerProxyArgs()],
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
