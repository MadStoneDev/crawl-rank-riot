import { ScanResult } from "../types";
import { UrlProcessor } from "../utils/url";
import puppeteer, { Browser, Page } from "puppeteer";

export class Scanner {
  private userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  async scan(
    url: string,
    depth: number,
    forceHeadless: boolean = false,
  ): Promise<ScanResult> {
    const startTime = Date.now();

    // For Shopify and other JS-heavy sites, skip HTTP and go straight to headless
    if (this.isJavaScriptHeavySite(url) || forceHeadless) {
      console.log(`🎭 Using headless browser for JS-heavy site: ${url}`);
      const result = await this.headlessScan(url, depth);
      result.load_time_ms = Date.now() - startTime;
      return result;
    }

    // Try HTTP first
    let result = await this.httpScan(url, depth);

    // Use headless if suspicious (like payment provider titles)
    if (this.needsHeadlessVerification(result)) {
      console.log(`🔍 Using headless browser for suspicious result: ${url}`);
      result = await this.headlessScan(url, depth);
    }

    result.load_time_ms = Date.now() - startTime;
    return result;
  }

  private isJavaScriptHeavySite(url: string): boolean {
    const jsHeavyPlatforms = [
      // E-commerce platforms
      "shopify.com",
      "shopifypreview.com",
      "myshopify.com",
      "squarespace.com",
      "wix.com",
      "webflow.io",

      // SPA frameworks (common patterns)
      // We can detect these by checking if URL contains these patterns
    ];

    // Check if URL contains any JS-heavy platform indicators
    const lowerUrl = url.toLowerCase();
    return jsHeavyPlatforms.some((platform) => lowerUrl.includes(platform));
  }

  private async headlessScan(url: string, depth: number): Promise<ScanResult> {
    const urlProcessor = new UrlProcessor(url);
    const result = this.createBaseScanResult(url, depth);

    let browser: Browser | undefined;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-web-security", // Help with CORS issues
          "--disable-features=VizDisplayCompositor", // Performance
        ],
      });

      const page: Page = await browser.newPage();

      // Set realistic viewport and user agent
      await page.setUserAgent(this.userAgent);
      await page.setViewport({ width: 1280, height: 800 });

      // Enable request interception to block unnecessary resources
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        // Block images, fonts, and media to speed up loading
        if (["image", "font", "media"].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Navigate and wait for network to be mostly idle
      const response = await page.goto(url, {
        waitUntil: "networkidle0", // Wait until no requests for 500ms
        timeout: 45000, // Longer timeout for JS-heavy sites
      });

      result.status = response?.status() || 0;
      result.url = urlProcessor.normalize(page.url());

      if (page.url() !== url) {
        result.is_redirect = true;
        result.redirected_from = url;
      }

      // CRITICAL: Wait longer for Shopify content to load
      console.log("⏳ Waiting for dynamic content to load...");
      await page
        .waitForFunction(
          () => {
            // Wait for page to be loaded and interactive
            return (
              document.readyState === "complete" &&
              document.body &&
              !document.body.classList.contains("loading")
            );
          },
          { timeout: 10000 },
        )
        .catch(() => {
          // Fallback if condition never met
          console.log("⚠️ Page load condition not met, continuing...");
        });

      // Wait for common Shopify elements to appear
      try {
        await page.waitForSelector("body", { timeout: 10000 });

        // Try to wait for product grids or navigation to load
        await Promise.race([
          page.waitForSelector('[class*="product"]', { timeout: 5000 }),
          page.waitForSelector('[class*="collection"]', { timeout: 5000 }),
          page.waitForSelector("nav", { timeout: 5000 }),
          await page
            .waitForFunction(
              () => {
                // Wait for page to be loaded and interactive
                return (
                  document.readyState === "complete" &&
                  document.body &&
                  !document.body.classList.contains("loading")
                );
              },
              { timeout: 10000 },
            )
            .catch(() => {
              // Fallback if condition never met
              console.log("⚠️ Page load condition not met, continuing...");
            }),
        ]);
      } catch (e) {
        console.log("⚠️ Dynamic content selectors not found, continuing...");
      }

      // Extract title with better Shopify handling
      result.title = await this.extractTitleFromPage(page);

      // Extract meta description
      try {
        const metaDescription = await page.$eval(
          'meta[name="description"], meta[property="og:description"]',
          (el: Element) => (el as HTMLMetaElement).getAttribute("content"),
        );
        result.meta_description = metaDescription || "";
      } catch {
        result.meta_description = "";
      }

      // Extract headings
      result.h1s = await page.$$eval("h1", (els: Element[]) =>
        els
          .map((el) => el.textContent?.trim() || "")
          .filter((text) => text.length > 0),
      );
      result.h2s = await page.$$eval("h2", (els: Element[]) =>
        els
          .map((el) => el.textContent?.trim() || "")
          .filter((text) => text.length > 0),
      );
      result.h3s = await page.$$eval("h3", (els: Element[]) =>
        els
          .map((el) => el.textContent?.trim() || "")
          .filter((text) => text.length > 0),
      );

      // Extract content (excluding scripts and styles)
      const content = await page.evaluate(() => {
        // Remove script and style elements
        const scripts = document.querySelectorAll("script, style, noscript");
        scripts.forEach((s) => s.remove());

        // Get text content from body
        return document.body.textContent || "";
      });

      result.content_length = content.length;
      result.word_count = content
        .split(/\s+/)
        .filter((w) => w.length > 0).length;

      // CRITICAL: Enhanced link extraction for Shopify
      await this.extractLinksFromShopifyPage(page, result, urlProcessor);

      // Extract images with sizes
      await this.extractImagesFromPage(page, result, urlProcessor);

      // Mark as headless scan
      result.scan_method = "headless";

      console.log(
        `🎭 Headless scan completed: ${result.title} (${result.internal_links.length} internal links)`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors = [`Headless scan failed: ${errorMessage}`];
      console.error(`❌ Headless scan error for ${url}:`, error);
    } finally {
      if (browser) {
        await browser.close();
      }
    }

    return result;
  }

  private async extractTitleFromPage(page: Page): Promise<string> {
    try {
      // Try multiple title sources in order of preference
      const titleSources = [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
        "title",
        "h1",
        '[class*="title"]',
        ".product-title",
        ".page-title",
      ];

      for (const selector of titleSources) {
        try {
          const title = await page.$eval(selector, (el: Element) => {
            if (el.tagName.toLowerCase() === "meta") {
              return (el as HTMLMetaElement).getAttribute("content") || "";
            }
            return el.textContent?.trim() || "";
          });

          if (
            title &&
            title.length > 0 &&
            !this.isPaymentProviderTitle(title)
          ) {
            return title;
          }
        } catch (e) {
          // Try next selector
          continue;
        }
      }

      // Fallback: get page title and clean it
      const rawTitle = await page.title();
      return this.cleanShopifyTitle(rawTitle);
    } catch (error) {
      console.error("Error extracting title:", error);
      return "";
    }
  }

  private isPaymentProviderTitle(title: string): boolean {
    const paymentProviders = [
      "American Express",
      "Visa",
      "MasterCard",
      "PayPal",
      "Apple Pay",
      "Google Pay",
      "Stripe",
      "Shop Pay",
    ];
    return paymentProviders.includes(title.trim());
  }

  private cleanShopifyTitle(title: string): string {
    // Remove common Shopify suffixes and payment provider names
    let cleaned = title
      .replace(/\s*–\s*.*$/, "") // Remove everything after –
      .replace(/\s*\|\s*.*$/, "") // Remove everything after |
      .replace(
        /American Express|Visa|MasterCard|PayPal|Apple Pay|Google Pay|Stripe|Shop Pay/gi,
        "",
      )
      .trim();

    return cleaned || title; // Return original if cleaning results in empty string
  }

  private async extractLinksFromShopifyPage(
    page: Page,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    try {
      // Get all links including dynamically loaded ones
      const links = await page.evaluate(() => {
        const linkElements = Array.from(document.querySelectorAll("a[href]"));

        return linkElements
          .map((a: Element) => {
            const anchor = a as HTMLAnchorElement;
            return {
              href: anchor.href,
              text: anchor.textContent?.trim() || "",
              rel: anchor.getAttribute("rel") || "",
              className: anchor.className || "",
              // Get parent context to identify navigation vs product links
              parentClass: anchor.parentElement?.className || "",
            };
          })
          .filter(
            (link) =>
              link.href &&
              !link.href.startsWith("javascript:") &&
              !link.href.startsWith("mailto:") &&
              !link.href.startsWith("tel:") &&
              link.href !== "#",
          );
      });

      console.log(`🔗 Found ${links.length} total links on page`);

      for (const link of links) {
        try {
          const normalizedUrl = urlProcessor.normalize(link.href);

          if (urlProcessor.isInternal(normalizedUrl)) {
            result.internal_links.push({
              url: normalizedUrl,
              anchor_text: link.text,
              rel_attributes: link.rel ? link.rel.split(" ") : [],
            });
          } else {
            result.external_links.push({
              url: normalizedUrl,
              anchor_text: link.text,
              rel_attributes: link.rel ? link.rel.split(" ") : [],
            });
          }
        } catch (error) {
          // Skip invalid URLs
          console.log(`⚠️ Skipping invalid URL: ${link.href}`);
        }
      }

      console.log(
        `✅ Processed ${result.internal_links.length} internal links, ${result.external_links.length} external links`,
      );
    } catch (error) {
      console.error("Error extracting links:", error);
    }
  }

  // Update needsHeadlessVerification to be more aggressive for e-commerce
  private needsHeadlessVerification(result: ScanResult): boolean {
    const paymentProviders = [
      "American Express",
      "Visa",
      "MasterCard",
      "PayPal",
      "Apple Pay",
      "Google Pay",
      "Stripe",
      "Shop Pay",
    ];

    return (
      paymentProviders.includes(result.title || "") ||
      !result.title ||
      result.title.length < 3 ||
      (result.content_type?.includes("text/html") &&
        result.content_length < 1000) ||
      (result.h1s.length === 0 && result.h2s.length === 0) ||
      result.internal_links.length < 3 // Very few links suggests missing JS content
    );
  }

  private async httpScan(url: string, depth: number): Promise<ScanResult> {
    const urlProcessor = new UrlProcessor(url);
    const result = this.createBaseScanResult(url, depth);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate",
          "Cache-Control": "no-cache",
        },
        redirect: "follow",
      });

      result.status = response.status;
      result.content_type = response.headers.get("content-type") || "";

      if (response.url !== url) {
        result.is_redirect = true;
        result.redirected_from = url;
        result.url = urlProcessor.normalize(response.url);
      }

      if (!result.content_type.includes("text/html")) {
        return result;
      }

      const html = await response.text();
      result.size_bytes = new TextEncoder().encode(html).length;

      await this.processHtml(result, html, urlProcessor);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors = [`HTTP scan failed: ${errorMessage}`];
    }

    return result;
  }

  private async processHtml(
    result: ScanResult,
    html: string,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    // Extract title - Fix for Shopify payment provider issue
    let title = "";
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].trim();

      // Check if title is a payment provider - if so, look for alternatives
      const paymentProviders = [
        "American Express",
        "Visa",
        "MasterCard",
        "PayPal",
        "Apple Pay",
        "Google Pay",
        "Stripe",
        "Shop Pay",
      ];
      if (paymentProviders.includes(title)) {
        // Look for h1 or other title indicators
        const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
        if (h1Match) {
          const h1Text = h1Match[1].replace(/<[^>]+>/g, "").trim();
          if (h1Text && !paymentProviders.includes(h1Text)) {
            title = h1Text;
          }
        }

        // Look for og:title
        const ogTitleMatch = html.match(
          /<meta[^>]*property=["']og:title["'][^>]*content=["'](.*?)["']/i,
        );
        if (ogTitleMatch && !paymentProviders.includes(ogTitleMatch[1])) {
          title = ogTitleMatch[1];
        }
      }
    }
    result.title = title;

    // Extract meta description
    const metaMatch = html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i,
    );
    if (metaMatch) {
      result.meta_description = metaMatch[1];
    }

    // Extract headings using regex
    const extractHeadings = (tag: string) => {
      const regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, "gi");
      const headings = [];
      let match;
      while ((match = regex.exec(html)) !== null) {
        headings.push(match[1].replace(/<[^>]+>/g, "").trim());
      }
      return headings;
    };

    result.h1s = extractHeadings("h1");
    result.h2s = extractHeadings("h2");
    result.h3s = extractHeadings("h3");

    // Extract and process links
    this.extractLinksFromHtml(html, result, urlProcessor);

    // Extract images
    this.extractImagesFromHtml(html, result, urlProcessor);

    // Extract content
    const textContent = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    result.content_length = textContent.length;
    result.word_count = textContent
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
  }

  private extractLinksFromHtml(
    html: string,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): void {
    const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const text = match[2].replace(/<[^>]+>/g, "").trim();

      if (!href || href === "#" || href.startsWith("javascript:")) continue;

      try {
        const resolvedUrl = urlProcessor.resolve(result.url, href);
        if (!resolvedUrl) continue;

        const linkData = {
          url: resolvedUrl,
          anchor_text: text || href,
          rel_attributes: [],
        };

        if (urlProcessor.isInternal(resolvedUrl)) {
          result.internal_links.push(linkData);
        } else {
          result.external_links.push(linkData);
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  private extractImagesFromHtml(
    html: string,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): void {
    const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
      const src = match[1];

      try {
        const resolvedUrl = urlProcessor.resolve(result.url, src);
        if (!resolvedUrl) continue;

        const altMatch = match[0].match(/alt=["'](.*?)["']/i);

        result.images.push({
          src: resolvedUrl,
          alt: altMatch ? altMatch[1] : "",
          // Note: Size will be fetched separately for HTTP scans
          dimensions: { width: 0, height: 0 },
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  private async extractLinksFromPage(
    page: Page,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("a[href]")).map(
        (a: Element) => {
          const anchor = a as HTMLAnchorElement;
          return {
            href: anchor.href,
            text: anchor.textContent?.trim() || "",
            rel: anchor.getAttribute("rel") || "",
          };
        },
      );
    });

    for (const link of links) {
      if (urlProcessor.isInternal(link.href)) {
        result.internal_links.push({
          url: link.href,
          anchor_text: link.text,
          rel_attributes: link.rel ? link.rel.split(" ") : [],
        });
      } else {
        result.external_links.push({
          url: link.href,
          anchor_text: link.text,
          rel_attributes: link.rel ? link.rel.split(" ") : [],
        });
      }
    }
  }

  private async extractImagesFromPage(
    page: Page,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    const images = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img")).map(
        (img: Element) => {
          const image = img as HTMLImageElement;
          return {
            src: image.src,
            alt: image.alt || "",
            width: image.naturalWidth || image.width || 0,
            height: image.naturalHeight || image.height || 0,
          };
        },
      );
    });

    for (const img of images) {
      try {
        const resolvedUrl = urlProcessor.resolve(result.url, img.src);
        if (!resolvedUrl) continue;

        result.images.push({
          src: resolvedUrl,
          alt: img.alt,
          dimensions: { width: img.width, height: img.height },
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  private createBaseScanResult(url: string, depth: number): ScanResult {
    return {
      url,
      status: 0,
      depth,
      title: "",
      meta_description: "",
      h1s: [],
      h2s: [],
      h3s: [],
      h4s: [],
      h5s: [],
      h6s: [],
      content_length: 0,
      word_count: 0,
      open_graph: {},
      twitter_card: {},
      canonical_url: null,
      is_indexable: true,
      has_robots_noindex: false,
      has_robots_nofollow: false,
      internal_links: [],
      external_links: [],
      images: [],
      redirect_url: null,
      content_type: "",
      size_bytes: 0,
      load_time_ms: 0,
      first_byte_time_ms: 0,
      structured_data: [],
      schema_types: [],
      js_count: 0,
      css_count: 0,
      keywords: [],
      scan_method: "http",
      scanned_at: new Date().toISOString(),
      errors: [],
      warnings: [],
    };
  }
}
