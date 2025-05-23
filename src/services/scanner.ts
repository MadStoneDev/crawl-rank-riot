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

    // For e-commerce and JS-heavy sites, use headless browser
    if (this.isJavaScriptHeavySite(url) || forceHeadless) {
      console.log(`🎭 Using headless browser for: ${url}`);
      const result = await this.headlessScan(url, depth);
      result.load_time_ms = Date.now() - startTime;
      return result;
    }

    // Try HTTP first for simple sites
    let result = await this.httpScan(url, depth);

    // Use headless if the result looks suspicious
    if (this.needsHeadlessVerification(result)) {
      console.log(`🔍 Retrying with headless browser: ${url}`);
      result = await this.headlessScan(url, depth);
    }

    result.load_time_ms = Date.now() - startTime;
    return result;
  }

  private isJavaScriptHeavySite(url: string): boolean {
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
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
      });

      const page: Page = await browser.newPage();

      // Set realistic viewport and user agent
      await page.setUserAgent(this.userAgent);
      await page.setViewport({ width: 1280, height: 800 });

      // Block unnecessary resources to speed up loading
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const resourceType = req.resourceType();
        // Block images, fonts, and media but allow scripts and stylesheets
        if (["image", "font", "media"].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Navigate with extended timeout for e-commerce sites
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      result.status = response?.status() || 0;
      result.url = urlProcessor.normalize(page.url());

      if (page.url() !== url) {
        result.is_redirect = true;
        result.redirected_from = url;
      }

      // Wait for dynamic content to load
      console.log("⏳ Waiting for dynamic content...");
      await this.waitForDynamicContent(page);

      // Extract all data from the page
      await this.extractPageData(page, result, urlProcessor);

      console.log(
        `🎭 Headless scan completed: ${result.title} (${result.internal_links.length} internal, ${result.external_links.length} external links)`,
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

  private async waitForDynamicContent(page: Page): Promise<void> {
    try {
      // Wait for document to be ready
      await page.waitForFunction(() => document.readyState === "complete", {
        timeout: 15000,
      });

      // Wait for common e-commerce elements
      await Promise.race([
        // Wait for products to load
        page.waitForSelector(
          '[class*="product"], [data-product], .product-item, .product-card',
          { timeout: 10000 },
        ),
        // Wait for collections to load
        page.waitForSelector(
          '[class*="collection"], [data-collection], .collection-item',
          { timeout: 10000 },
        ),
        // Wait for navigation to be complete
        page.waitForSelector('nav[class*="nav"], .navigation, .menu', {
          timeout: 8000,
        }),
        // Wait for main content
        page.waitForSelector("main, .main, #main, .content", { timeout: 8000 }),
        // Fallback timeout
        this.delay(8000),
      ]);

      // Additional wait for Shopify-specific elements
      if (this.isJavaScriptHeavySite(page.url())) {
        await Promise.race([
          page.waitForSelector("[data-section-type], .shopify-section", {
            timeout: 5000,
          }),
          page.waitForFunction(
            () =>
              !document.body.classList.contains("loading") &&
              !document.querySelector('.loading, .spinner, [class*="load"]'),
            { timeout: 10000 },
          ),
          this.delay(5000),
        ]);
      }
    } catch (error) {
      console.log("⚠️ Dynamic content wait timeout, continuing with scan...");
    }
  }

  private async extractPageData(
    page: Page,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    // Extract title with multiple fallbacks
    result.title = await this.extractTitle(page);

    // Extract meta description
    result.meta_description = await this.extractMetaDescription(page);

    // Extract headings
    const headings = await this.extractHeadings(page);
    result.h1s = headings.h1s;
    result.h2s = headings.h2s;
    result.h3s = headings.h3s;
    result.h4s = headings.h4s;
    result.h5s = headings.h5s;
    result.h6s = headings.h6s;

    // Extract content stats
    const contentStats = await this.extractContentStats(page);
    result.content_length = contentStats.contentLength;
    result.word_count = contentStats.wordCount;

    // Extract meta tags
    const metaTags = await this.extractMetaTags(page);
    result.open_graph = metaTags.openGraph;
    result.twitter_card = metaTags.twitterCard;
    result.canonical_url = metaTags.canonical;
    result.is_indexable = metaTags.isIndexable;
    result.has_robots_noindex = metaTags.hasRobotsNoindex;
    result.has_robots_nofollow = metaTags.hasRobotsNofollow;

    // Extract links with enhanced detection
    await this.extractLinks(page, result, urlProcessor);

    // Extract images
    await this.extractImages(page, result, urlProcessor);

    // Extract technical data
    const techData = await this.extractTechnicalData(page);
    result.js_count = techData.jsCount;
    result.css_count = techData.cssCount;
    result.structured_data = techData.structuredData;
    result.schema_types = techData.schemaTypes;

    // Mark as headless scan
    result.scan_method = "headless";
  }

  private async extractTitle(page: Page): Promise<string> {
    try {
      // Multiple strategies to get the correct title
      const titleStrategies = [
        // Strategy 1: Page title
        () => page.title(),

        // Strategy 2: Open Graph title
        () =>
          page.$eval('meta[property="og:title"]', (el) =>
            el.getAttribute("content"),
          ),

        // Strategy 3: First meaningful H1
        () => page.$eval("h1", (el) => el.textContent?.trim()),

        // Strategy 4: Twitter title
        () =>
          page.$eval('meta[name="twitter:title"]', (el) =>
            el.getAttribute("content"),
          ),

        // Strategy 5: Product-specific selectors for e-commerce
        () =>
          page.$eval(
            ".product-title, .product-name, [data-product-title]",
            (el) => el.textContent?.trim(),
          ),

        // Strategy 6: Page-specific selectors
        () =>
          page.$eval(
            ".page-title, .hero-title, h1.title",
            (el) => el.textContent?.trim(),
          ),
      ];

      for (const strategy of titleStrategies) {
        try {
          const title = await strategy();
          if (title && this.isValidTitle(title)) {
            return this.cleanTitle(title);
          }
        } catch (e) {
          // Try next strategy
          continue;
        }
      }

      // Fallback to page title even if it seems invalid
      const fallbackTitle = await page.title();
      return this.cleanTitle(fallbackTitle);
    } catch (error) {
      console.error("Error extracting title:", error);
      return "";
    }
  }

  private isValidTitle(title: string): boolean {
    if (!title || title.length < 2) return false;

    // Check for payment provider titles that shouldn't be page titles
    const paymentProviders = [
      "American Express",
      "Visa",
      "MasterCard",
      "PayPal",
      "Apple Pay",
      "Google Pay",
      "Stripe",
      "Shop Pay",
      "Klarna",
      "Afterpay",
      "Sezzle",
    ];

    const trimmedTitle = title.trim();
    return !paymentProviders.some(
      (provider) =>
        trimmedTitle === provider ||
        trimmedTitle.toLowerCase() === provider.toLowerCase(),
    );
  }

  private cleanTitle(title: string): string {
    if (!title) return "";

    // Remove common e-commerce suffixes and clean up
    return title
      .replace(/\s*[–|—]\s*.*$/, "") // Remove everything after em dash
      .replace(/\s*\|\s*.*$/, "") // Remove everything after pipe
      .replace(/\s*-\s*.*$/, "") // Remove everything after hyphen (be careful with this)
      .trim();
  }

  private async extractMetaDescription(page: Page): Promise<string> {
    try {
      const selectors = [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
      ];

      for (const selector of selectors) {
        try {
          const content = await page.$eval(selector, (el) =>
            el.getAttribute("content"),
          );
          if (content && content.trim().length > 0) {
            return content.trim();
          }
        } catch (e) {
          continue;
        }
      }
      return "";
    } catch (error) {
      return "";
    }
  }

  private async extractHeadings(page: Page): Promise<{
    h1s: string[];
    h2s: string[];
    h3s: string[];
    h4s: string[];
    h5s: string[];
    h6s: string[];
  }> {
    try {
      return await page.evaluate(() => {
        const getHeadings = (tag: string) => {
          return Array.from(document.querySelectorAll(tag))
            .map((el) => el.textContent?.trim() || "")
            .filter((text) => text.length > 0);
        };

        return {
          h1s: getHeadings("h1"),
          h2s: getHeadings("h2"),
          h3s: getHeadings("h3"),
          h4s: getHeadings("h4"),
          h5s: getHeadings("h5"),
          h6s: getHeadings("h6"),
        };
      });
    } catch (error) {
      return { h1s: [], h2s: [], h3s: [], h4s: [], h5s: [], h6s: [] };
    }
  }

  private async extractContentStats(
    page: Page,
  ): Promise<{ contentLength: number; wordCount: number }> {
    try {
      return await page.evaluate(() => {
        // Remove script and style elements
        const clonedBody = document.body.cloneNode(true) as HTMLElement;
        const scripts = clonedBody.querySelectorAll("script, style, noscript");
        scripts.forEach((el) => el.remove());

        const content = clonedBody.textContent || "";
        const words = content
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0);

        return {
          contentLength: content.length,
          wordCount: words.length,
        };
      });
    } catch (error) {
      return { contentLength: 0, wordCount: 0 };
    }
  }

  private async extractMetaTags(page: Page): Promise<{
    openGraph: Record<string, string>;
    twitterCard: Record<string, string>;
    canonical: string | null;
    isIndexable: boolean;
    hasRobotsNoindex: boolean;
    hasRobotsNofollow: boolean;
  }> {
    try {
      return await page.evaluate(() => {
        const openGraph: Record<string, string> = {};
        const twitterCard: Record<string, string> = {};

        // Extract Open Graph tags
        document.querySelectorAll('meta[property^="og:"]').forEach((meta) => {
          const property = meta.getAttribute("property");
          const content = meta.getAttribute("content");
          if (property && content) {
            openGraph[property.replace("og:", "")] = content;
          }
        });

        // Extract Twitter Card tags
        document.querySelectorAll('meta[name^="twitter:"]').forEach((meta) => {
          const name = meta.getAttribute("name");
          const content = meta.getAttribute("content");
          if (name && content) {
            twitterCard[name.replace("twitter:", "")] = content;
          }
        });

        // Extract canonical URL
        const canonicalEl = document.querySelector(
          'link[rel="canonical"]',
        ) as HTMLLinkElement;
        const canonical = canonicalEl ? canonicalEl.href : null;

        // Check robots meta tags
        const robotsMeta = document.querySelector('meta[name="robots"]');
        const robotsContent = robotsMeta
          ? robotsMeta.getAttribute("content")?.toLowerCase() || ""
          : "";

        return {
          openGraph,
          twitterCard,
          canonical,
          isIndexable: !robotsContent.includes("noindex"),
          hasRobotsNoindex: robotsContent.includes("noindex"),
          hasRobotsNofollow: robotsContent.includes("nofollow"),
        };
      });
    } catch (error) {
      return {
        openGraph: {},
        twitterCard: {},
        canonical: null,
        isIndexable: true,
        hasRobotsNoindex: false,
        hasRobotsNofollow: false,
      };
    }
  }

  private async extractLinks(
    page: Page,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    try {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((a) => {
            const anchor = a as HTMLAnchorElement;
            return {
              href: anchor.href,
              text: anchor.textContent?.trim() || "",
              rel: anchor.getAttribute("rel") || "",
              className: anchor.className || "",
              dataset: { ...anchor.dataset },
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

      console.log(`🔗 Found ${links.length} links on page`);

      for (const link of links) {
        try {
          const normalizedUrl = urlProcessor.normalize(link.href);

          const linkData = {
            url: normalizedUrl,
            anchor_text: link.text,
            rel_attributes: link.rel
              ? link.rel.split(" ").filter((r) => r.length > 0)
              : [],
          };

          if (urlProcessor.isInternal(normalizedUrl)) {
            result.internal_links.push(linkData);
          } else {
            result.external_links.push(linkData);
          }
        } catch (error) {
          console.log(`⚠️ Skipping invalid URL: ${link.href}`);
        }
      }

      console.log(
        `✅ Processed ${result.internal_links.length} internal, ${result.external_links.length} external links`,
      );
    } catch (error) {
      console.error("Error extracting links:", error);
    }
  }

  private async extractImages(
    page: Page,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    try {
      const images = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("img")).map((img) => ({
          src: img.src,
          alt: img.alt || "",
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0,
        }));
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
    } catch (error) {
      console.error("Error extracting images:", error);
    }
  }

  private async extractTechnicalData(page: Page): Promise<{
    jsCount: number;
    cssCount: number;
    structuredData: any[];
    schemaTypes: string[];
  }> {
    try {
      return await page.evaluate(() => {
        const jsCount = document.querySelectorAll("script[src]").length;
        const cssCount = document.querySelectorAll(
          'link[rel="stylesheet"]',
        ).length;

        // Extract structured data
        const structuredData: any[] = [];
        const schemaTypes: string[] = [];

        // JSON-LD structured data
        document
          .querySelectorAll('script[type="application/ld+json"]')
          .forEach((script) => {
            try {
              const data = JSON.parse(script.textContent || "");
              structuredData.push(data);

              // Extract schema types
              if (data["@type"]) {
                schemaTypes.push(data["@type"]);
              }
              if (Array.isArray(data) && data.length > 0 && data[0]["@type"]) {
                schemaTypes.push(data[0]["@type"]);
              }
            } catch (e) {
              // Invalid JSON, skip
            }
          });

        return {
          jsCount,
          cssCount,
          structuredData,
          schemaTypes: [...new Set(schemaTypes)], // Remove duplicates
        };
      });
    } catch (error) {
      return {
        jsCount: 0,
        cssCount: 0,
        structuredData: [],
        schemaTypes: [],
      };
    }
  }

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
      "Klarna",
      "Afterpay",
      "Sezzle",
    ];

    return (
      !result.title ||
      paymentProviders.some((provider) => result.title?.includes(provider)) ||
      result.title.length < 3 ||
      (result.content_type?.includes("text/html") &&
        result.content_length < 1000) ||
      (result.h1s.length === 0 && result.h2s.length === 0) ||
      result.internal_links.length < 2
    );
  }

  private async httpScan(url: string, depth: number): Promise<ScanResult> {
    const urlProcessor = new UrlProcessor(url);
    const result = this.createBaseScanResult(url, depth);

    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

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
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

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
      result.scan_method = "http";
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
    // Extract title with fallbacks
    result.title = this.extractTitleFromHtml(html);

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
        const text = match[1].replace(/<[^>]+>/g, "").trim();
        if (text.length > 0) {
          headings.push(text);
        }
      }
      return headings;
    };

    result.h1s = extractHeadings("h1");
    result.h2s = extractHeadings("h2");
    result.h3s = extractHeadings("h3");
    result.h4s = extractHeadings("h4");
    result.h5s = extractHeadings("h5");
    result.h6s = extractHeadings("h6");

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

    // Extract meta tags
    result.canonical_url = this.extractCanonicalFromHtml(html);
    result.is_indexable = !this.hasRobotsNoindex(html);
    result.has_robots_noindex = this.hasRobotsNoindex(html);
    result.has_robots_nofollow = this.hasRobotsNofollow(html);
  }

  private extractTitleFromHtml(html: string): string {
    // Try multiple strategies for title extraction
    const strategies = [
      // Strategy 1: Regular title tag
      () => {
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
        return titleMatch ? titleMatch[1].trim() : null;
      },

      // Strategy 2: Open Graph title
      () => {
        const ogMatch = html.match(
          /<meta[^>]*property=["']og:title["'][^>]*content=["'](.*?)["']/i,
        );
        return ogMatch ? ogMatch[1] : null;
      },

      // Strategy 3: First H1
      () => {
        const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
        return h1Match ? h1Match[1].replace(/<[^>]+>/g, "").trim() : null;
      },
    ];

    for (const strategy of strategies) {
      try {
        const title = strategy();
        if (title && this.isValidTitle(title)) {
          return this.cleanTitle(title);
        }
      } catch (e) {
        continue;
      }
    }

    // Fallback to first title found, even if invalid
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    return titleMatch ? this.cleanTitle(titleMatch[1].trim()) : "";
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

        // Extract rel attributes
        const relMatch = match[0].match(/rel=["']([^"']*)["']/i);
        const relAttributes = relMatch
          ? relMatch[1].split(" ").filter((r) => r.length > 0)
          : [];

        const linkData = {
          url: resolvedUrl,
          anchor_text: text || href,
          rel_attributes: relAttributes,
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
          dimensions: { width: 0, height: 0 },
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  private extractCanonicalFromHtml(html: string): string | null {
    const canonicalMatch = html.match(
      /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i,
    );
    return canonicalMatch ? canonicalMatch[1] : null;
  }

  private hasRobotsNoindex(html: string): boolean {
    const robotsMatch = html.match(
      /<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i,
    );
    return robotsMatch
      ? robotsMatch[1].toLowerCase().includes("noindex")
      : false;
  }

  private hasRobotsNofollow(html: string): boolean {
    const robotsMatch = html.match(
      /<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i,
    );
    return robotsMatch
      ? robotsMatch[1].toLowerCase().includes("nofollow")
      : false;
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
