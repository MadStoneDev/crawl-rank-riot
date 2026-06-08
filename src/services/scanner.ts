import { createHash } from "crypto";
import { ScanResult } from "../types";
import { UrlProcessor, isPublicUrl } from "../utils/url";
import { isJavaScriptHeavySite, getSharedBrowserPool, detectPlatformFromHeaders, detectPlatformFromHtml, platformNeedsHeadless } from "../utils/browser";
import { Page } from "puppeteer";

export class Scanner {
  private userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  async scan(
    url: string,
    depth: number,
    forceHeadless: boolean = false,
  ): Promise<ScanResult> {
    const startTime = Date.now();

    // SSRF protection: block requests to private/reserved IP ranges
    const isSafe = await isPublicUrl(url);
    if (!isSafe) {
      const result = this.createBaseScanResult(url, depth);
      result.errors = [`Blocked: URL resolves to a private or reserved IP address`];
      result.status = 0;
      return result;
    }

    // For e-commerce and JS-heavy sites, use headless browser
    if (isJavaScriptHeavySite(url) || forceHeadless) {
      console.log(`🎭 Using headless browser for: ${url}`);
      const result = await this.headlessScan(url, depth);
      result.load_time_ms = Date.now() - startTime;
      return result;
    }

    // Try HTTP first for simple sites
    let result = await this.httpScan(url, depth);

    // Check if the HTTP response revealed a JS-heavy platform
    const headerPlatform = (result as any)._detectedPlatform as string | undefined;
    const htmlPlatform = result.scan_method === "http"
      ? detectPlatformFromHtml((result as any)._rawHtml || "")
      : null;
    const detectedPlatform = headerPlatform || htmlPlatform;

    if (detectedPlatform) {
      console.log(`🔎 Detected platform: ${detectedPlatform} for ${url}`);
    }

    // Escalate to headless only when HTTP results are genuinely inadequate.
    // Platform detection alone is not enough — if HTTP got good data, keep it.
    // Never escalate bot challenges to headless — if HTTP got blocked, headless will too.
    const isBotChallenge = !!(result as any)._isBotChallenge;
    const httpResultsArePoor = !isBotChallenge && this.needsHeadlessVerification(result);

    if (isBotChallenge) {
      console.log(`🛡️ Bot challenge detected via HTTP for ${url} — skipping headless (will be blocked too)`);
      result.errors = [...(result.errors || []), "Blocked by bot protection (Cloudflare or similar)"];
      result.title = undefined;
      result.word_count = 0;
      result.content_length = 0;
    } else if (httpResultsArePoor) {
      const reason = detectedPlatform
          ? `platform=${detectedPlatform}`
          : "heuristic";
      console.log(`🔍 Retrying with headless browser: ${url} (${reason})`);
      const httpResult = result;
      const headlessResult = await this.headlessScan(url, depth);

      // Only use headless results if they're actually better than HTTP
      const headlessIsUsable =
        headlessResult.status >= 200 &&
        headlessResult.status < 400 &&
        (headlessResult.title || "").length > 0;

      if (headlessIsUsable) {
        const httpWc = httpResult.word_count || 0;
        const headlessWc = headlessResult.word_count || 0;
        const delta = headlessWc > 0 ? Math.round(((headlessWc - httpWc) / headlessWc) * 100) : 0;
        if (delta > 20) {
          headlessResult.js_rendering_gap = {
            http_word_count: httpWc,
            headless_word_count: headlessWc,
            delta_percent: delta,
          };
        }
        result = headlessResult;
      } else {
        console.log(`⚠️ Headless produced worse results for ${url} (status=${headlessResult.status}, title="${headlessResult.title || ""}"), keeping HTTP results`);
        result = httpResult;
      }
    } else if (detectedPlatform && platformNeedsHeadless(detectedPlatform)) {
      console.log(`ℹ️ Platform ${detectedPlatform} detected for ${url}, but HTTP scan got good results — skipping headless`);
    }

    // Clean up internal fields
    delete (result as any)._detectedPlatform;
    delete (result as any)._rawHtml;
    delete (result as any)._isBotChallenge;

    result.load_time_ms = Date.now() - startTime;
    return result;
  }

  private async headlessScan(url: string, depth: number): Promise<ScanResult> {
    const urlProcessor = new UrlProcessor(url);
    const result = this.createBaseScanResult(url, depth);

    const pool = getSharedBrowserPool();
    let page: Page | undefined;
    try {
      const browser = await pool.acquire();

      page = await browser.newPage();

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
      const navigateStart = Date.now();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      result.first_byte_time_ms = Date.now() - navigateStart;

      result.status = response?.status() || 0;
      result.url = urlProcessor.normalize(page.url());

      // Capture security headers from the response
      if (response) {
        result.security_headers = this.extractSecurityHeaders(response.headers());
      }

      if (page.url() !== url) {
        result.is_redirect = true;
        result.redirected_from = url;
        result.redirect_url = urlProcessor.normalize(page.url());
      }

      // Wait for dynamic content to load
      console.log("⏳ Waiting for dynamic content...");
      await this.waitForDynamicContent(page);

      // Check for bot challenge pages (Cloudflare, etc.) — quick check, don't wait long
      const challengeTitle = await page.title();
      if (this.isBotChallengePage(challengeTitle)) {
        console.log(`🛡️ Bot challenge detected for ${url}, brief wait for auto-resolution...`);
        await this.delay(3000);
        const postChallengeTitle = await page.title();
        if (this.isBotChallengePage(postChallengeTitle)) {
          console.log(`🚫 Bot challenge still present for ${url} — marking as blocked`);
          result.errors = [...(result.errors || []), "Blocked by bot protection (Cloudflare or similar)"];
          result.title = undefined;
          result.word_count = 0;
          result.content_length = 0;
          return result;
        }
        console.log(`✅ Bot challenge resolved for ${url}`);
      }

      // Extract all data from the page
      await this.extractPageData(page, result, urlProcessor);

      // Capture page size in bytes
      result.size_bytes = Buffer.byteLength(await page.content(), 'utf8');

      console.log(
        `🎭 Headless scan completed: ${result.title} (${result.internal_links.length} internal, ${result.external_links.length} external links)`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors = [`Headless scan failed: ${errorMessage}`];
      console.error(`❌ Headless scan error for ${url}:`, error);
    } finally {
      if (page) {
        try { await page.close(); } catch { /* page may already be closed */ }
      }
      pool.release();
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
      if (isJavaScriptHeavySite(page.url())) {
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

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    result.keywords = this.extractKeywords(bodyText);
    result.content_hash = this.computeContentHash(bodyText);
    result.readability_score = this.computeReadabilityScore(bodyText);

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
    await this.fetchImageFileSizes(result.images);

    // Extract technical data
    const techData = await this.extractTechnicalData(page);
    result.js_count = techData.jsCount;
    result.css_count = techData.cssCount;
    result.structured_data = techData.structuredData;
    result.schema_types = techData.schemaTypes;

    // Check for viewport meta tag
    result.has_viewport_meta = await page.evaluate(() => {
      return !!document.querySelector('meta[name="viewport"]');
    });

    // Check for mixed content (HTTPS page with HTTP resources)
    result.has_mixed_content = await page.evaluate(() => {
      if (window.location.protocol !== "https:") return false;
      const selectors = 'img[src^="http:"], script[src^="http:"], link[href^="http:"], iframe[src^="http:"], video[src^="http:"], audio[src^="http:"], source[src^="http:"], object[data^="http:"], embed[src^="http:"]';
      return document.querySelectorAll(selectors).length > 0;
    });

    // Extract hreflang tags
    result.hreflang_tags = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))
        .map((el) => ({
          lang: el.getAttribute("hreflang") || "",
          url: (el as HTMLLinkElement).href || "",
        }))
        .filter((tag) => tag.lang && tag.url);
    });

    // Check canonical_is_self
    result.canonical_is_self = this.checkCanonicalIsSelf(result.canonical_url, result.url);

    // Check URL issues
    result.url_issues = this.analyzeUrlIssues(result.url);

    // Check heading hierarchy
    const hierarchyResult = this.checkHeadingHierarchy(result);
    result.heading_hierarchy_valid = hierarchyResult.valid;
    result.heading_hierarchy_issues = hierarchyResult.issues;

    // Detect contact forms
    result.has_contact_form = await page.evaluate(() => {
      const forms = document.querySelectorAll("form");
      for (const form of forms) {
        const hasEmailInput = !!form.querySelector('input[type="email"], input[name*="email"], input[autocomplete="email"]');
        const hasTextarea = !!form.querySelector("textarea");
        const hasPhoneInput = !!form.querySelector('input[type="tel"], input[name*="phone"]');
        const hasNameInput = !!form.querySelector('input[name*="name"], input[autocomplete="name"]');
        if (hasEmailInput && (hasTextarea || hasPhoneInput || hasNameInput)) return true;
      }
      return false;
    });

    // CLS risk: images without explicit width/height attributes
    result.cls_risk_images = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img")).filter(img =>
        !img.getAttribute("width") || !img.getAttribute("height")
      ).length;
    });

    // LCP candidate: largest visible image or hero text
    result.lcp_candidate = await page.evaluate(() => {
      let largest = { type: "text", element: "", area: 0 };
      document.querySelectorAll("img").forEach(img => {
        const area = img.naturalWidth * img.naturalHeight;
        if (area > largest.area) {
          largest = { type: "image", element: img.src, area };
        }
      });
      document.querySelectorAll("h1, [class*='hero']").forEach(el => {
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > largest.area) {
          largest = { type: "text", element: (el.textContent || "").slice(0, 100), area };
        }
      });
      return largest.area > 0 ? { type: largest.type, element: largest.element } : undefined;
    });

    // Accessibility checks
    result.accessibility = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input, select, textarea");
      let missingLabels = 0;
      inputs.forEach(input => {
        const el = input as HTMLInputElement;
        if (el.type === "hidden" || el.type === "submit" || el.type === "button") return;
        const id = el.id;
        const hasLabel = (id && document.querySelector(`label[for="${id}"]`)) ||
                         el.closest("label") ||
                         el.getAttribute("aria-label") ||
                         el.getAttribute("aria-labelledby");
        if (!hasLabel) missingLabels++;
      });

      const landmarks = new Set<string>();
      document.querySelectorAll('nav, main, header, footer, aside, [role="navigation"], [role="main"], [role="banner"], [role="contentinfo"], [role="complementary"]')
        .forEach(el => landmarks.add(el.tagName.toLowerCase() === "div" ? (el.getAttribute("role") || "") : el.tagName.toLowerCase()));

      const hasSkipNav = Array.from(document.querySelectorAll('a[href^="#"]')).some(a => {
        const text = (a.textContent || "").toLowerCase();
        const rect = (a as HTMLElement).getBoundingClientRect();
        return (text.includes("skip") || text.includes("jump to")) && rect.top < 100;
      });

      const tabindexMisuse = Array.from(document.querySelectorAll("[tabindex]"))
        .filter(el => parseInt(el.getAttribute("tabindex") || "0") > 0).length;

      return {
        html_lang: document.documentElement.lang || undefined,
        form_labels_missing: missingLabels,
        aria_landmarks: [...landmarks],
        has_skip_nav: hasSkipNav,
        tabindex_misuse: tabindexMisuse,
      };
    });

    // Cookie consent detection
    result.has_cookie_consent = await page.evaluate(() => {
      const selectors = [
        '[class*="cookie"]', '[id*="cookie"]',
        '[class*="consent"]', '[id*="consent"]',
        '[class*="gdpr"]', '[id*="gdpr"]',
        '[class*="CookieBot"]', '[id*="onetrust"]',
        '[class*="cc-banner"]', '[class*="cookie-banner"]',
      ];
      return selectors.some(s => document.querySelector(s) !== null);
    });

    // Resource hints
    result.resource_hints = await page.evaluate(() => {
      const get = (rel: string) => Array.from(document.querySelectorAll(`link[rel="${rel}"]`))
        .map(l => (l as HTMLLinkElement).href).filter(Boolean);
      return {
        preconnect: get("preconnect"),
        preload: get("preload"),
        prefetch: get("prefetch"),
        dns_prefetch: get("dns-prefetch"),
      };
    });

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

    // Decode HTML entities
    const decoded = title
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");

    // Common site name patterns to remove (only at end of title)
    // These are typically brand suffixes like "Product Name | Brand" or "Page - Company Name"
    const siteNamePatterns = [
      /\s*[|–—]\s*(?:Official\s+)?(?:Site|Website|Home|Shop|Store|Online).*$/i,
      /\s*[|–—]\s*(?:Buy|Order|Get|Shop)\s+.*$/i,
      /\s*[|–—]\s*(?:Free Shipping|Fast Delivery).*$/i,
    ];

    let cleaned = decoded.trim();

    // Only apply site name removal if it looks like a suffix pattern
    for (const pattern of siteNamePatterns) {
      cleaned = cleaned.replace(pattern, "");
    }

    // Remove excessive whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();

    return cleaned;
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
              link.href !== "#" &&
              /^https?:\/\//i.test(link.href),
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
          loading: img.getAttribute("loading") || "",
          srcset: img.getAttribute("srcset") || "",
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
            loading: img.loading,
            srcset: img.srcset || undefined,
            format: this.deriveImageFormat(resolvedUrl),
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

              // Extract schema types (flatten arrays since @type can be ["Type1", "Type2"])
              if (data["@type"]) {
                const types = Array.isArray(data["@type"]) ? data["@type"] : [data["@type"]];
                schemaTypes.push(...types.filter((t: any) => typeof t === 'string'));
              }
              if (data["@graph"] && Array.isArray(data["@graph"])) {
                for (const item of data["@graph"]) {
                  if (item["@type"]) {
                    const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
                    schemaTypes.push(...types.filter((t: any) => typeof t === 'string'));
                  }
                }
              }
              if (Array.isArray(data) && data.length > 0 && data[0]["@type"]) {
                const types = Array.isArray(data[0]["@type"]) ? data[0]["@type"] : [data[0]["@type"]];
                schemaTypes.push(...types.filter((t: any) => typeof t === 'string'));
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

  private isBotChallengePage(title?: string, html?: string): boolean {
    if (title) {
      const t = title.toLowerCase().trim();
      const challengeTitles = [
        "one moment, please",
        "just a moment",
        "attention required",
        "access denied",
        "please wait",
        "checking your browser",
        "verify you are human",
        "security check",
        "ddos protection",
      ];
      if (challengeTitles.some(ct => t.startsWith(ct) || t.includes(ct))) {
        return true;
      }
    }
    if (html) {
      const challengeMarkers = [
        "cf-browser-verification",
        "challenge-platform",
        "cf-turnstile",
        "__cf_chl_opt",
        "cf-challenge-running",
        "cdn-cgi/challenge-platform",
        "managed-challenge",
        "ray ID",
      ];
      const lower = html.toLowerCase();
      if (challengeMarkers.some(m => lower.includes(m))) {
        return true;
      }
    }
    return false;
  }

  private needsHeadlessVerification(result: ScanResult): boolean {
    // No title at all — likely JS-rendered SPA
    if (!result.title || result.title.length < 3) return true;

    // Almost no text content — page body is probably rendered by JS
    if (result.content_type?.includes("text/html") && result.content_length < 500 && result.word_count < 5) return true;

    return false;
  }

  private async httpScan(url: string, depth: number): Promise<ScanResult> {
    const urlProcessor = new UrlProcessor(url);
    const result = this.createBaseScanResult(url, depth);

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 second timeout (covers headers + body)

        // Track redirect chain by following redirects manually
        const redirectChain: string[] = [];
        let currentUrl = url;
        let response: Response | null = null;
        const maxRedirects = 10;

        const fetchStart = Date.now();

        const seenUrls = new Set<string>();

        for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
          if (seenUrls.has(currentUrl)) {
            // Redirect loop detected — record it and break
            result.redirect_chain = [...redirectChain, currentUrl];
            break;
          }
          seenUrls.add(currentUrl);

          response = await fetch(currentUrl, {
            headers: {
              "User-Agent": this.userAgent,
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.5",
              "Accept-Encoding": "gzip, deflate",
              "Cache-Control": "no-cache",
            },
            redirect: "manual",
            signal: controller.signal,
          });

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (location) {
              redirectChain.push(currentUrl);
              // Resolve relative redirect URLs
              try {
                currentUrl = new URL(location, currentUrl).href;
              } catch {
                currentUrl = location;
              }
              continue;
            }
          }
          break;
        }

        result.first_byte_time_ms = Date.now() - fetchStart;

        if (!response) {
          clearTimeout(timeoutId);
          throw new Error("No response received");
        }

        // Store the redirect chain (only if there were redirects)
        if (redirectChain.length > 0) {
          result.redirect_chain = redirectChain;
        }

        result.status = response.status;
        result.content_type = response.headers.get("content-type") || "";

        // Capture security headers
        result.security_headers = this.extractSecurityHeadersFromFetch(response.headers);

        // Detect platform from response headers
        const headerPlatform = detectPlatformFromHeaders(response.headers);
        if (headerPlatform) {
          (result as any)._detectedPlatform = headerPlatform;
        }

        // Check X-Robots-Tag header for noindex/nofollow
        const xRobotsTag = response.headers.get("x-robots-tag") || "";
        if (xRobotsTag.toLowerCase().includes("noindex")) {
          result.has_robots_noindex = true;
          result.is_indexable = false;
        }
        if (xRobotsTag.toLowerCase().includes("nofollow")) {
          result.has_robots_nofollow = true;
        }

        if (currentUrl !== url) {
          result.is_redirect = true;
          result.redirected_from = url;
          result.redirect_url = urlProcessor.normalize(currentUrl);
          result.url = urlProcessor.normalize(currentUrl);
        }

        // Retry on 5xx errors (server errors are often transient)
        if (response.status >= 500 && attempt < maxRetries) {
          clearTimeout(timeoutId);
          console.log(`⚠️ Got ${response.status} for ${url}, retrying (attempt ${attempt}/${maxRetries})...`);
          await this.delay(1000 * attempt); // Exponential backoff
          continue;
        }

        if (!result.content_type.includes("text/html")) {
          clearTimeout(timeoutId);
          return result;
        }

        const html = await response.text();
        clearTimeout(timeoutId);
        result.size_bytes = new TextEncoder().encode(html).length;

        await this.processHtml(result, html, urlProcessor);
        result.scan_method = "http";
        // Attach raw HTML temporarily for platform detection in scan()
        (result as any)._rawHtml = html;
        // Flag bot challenge pages for headless escalation
        if (this.isBotChallengePage(result.title, html)) {
          (result as any)._isBotChallenge = true;
        }

        // Success - exit retry loop
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Node fetch wraps the real error in .cause
        const rootCause = (lastError as any).cause;
        const detail = rootCause
          ? `${rootCause.code || rootCause.name || ""} ${rootCause.message || ""}`.trim()
          : lastError.message;

        // Retry on network errors
        if (attempt < maxRetries) {
          console.log(`⚠️ Network error for ${url} (${detail}), retrying (attempt ${attempt}/${maxRetries})...`);
          await this.delay(1000 * attempt); // Exponential backoff
          continue;
        }
      }
    }

    // All retries failed
    const rootCause = (lastError as any)?.cause;
    const detail = rootCause
      ? `${rootCause.code || rootCause.name || ""} ${rootCause.message || ""}`.trim()
      : lastError?.message || "Unknown error";
    result.errors = [`HTTP scan failed after ${maxRetries} attempts: ${detail}`];
    return result;
  }

  private async processHtml(
    result: ScanResult,
    html: string,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    // Extract title with fallbacks
    result.title = this.extractTitleFromHtml(html);

    // Extract meta description (handle both attribute orders)
    const metaMatch = html.match(
      /<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i,
    ) || html.match(
      /<meta[^>]*content=["'](.*?)["'][^>]*name=["']description["']/i,
    );
    if (metaMatch) {
      result.meta_description = metaMatch[1];
    }

    // Extract headings using regex
    const extractHeadings = (tag: string) => {
      const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
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

    result.content_hash = this.computeContentHash(textContent);
    result.readability_score = this.computeReadabilityScore(textContent);

    // Extract keywords from page content
    result.keywords = this.extractKeywords(textContent);

    // Extract meta tags (merge with header-based detection, don't override)
    result.canonical_url = this.extractCanonicalFromHtml(html);
    if (this.hasRobotsNoindex(html)) {
      result.has_robots_noindex = true;
      result.is_indexable = false;
    }
    if (this.hasRobotsNofollow(html)) {
      result.has_robots_nofollow = true;
    }
    // Set indexable to true only if not already set to false by headers or meta
    if (result.is_indexable === undefined || result.is_indexable === null) {
      result.is_indexable = !result.has_robots_noindex;
    }

    // Extract Open Graph tags
    const ogRegex = /<meta[^>]*property=["']og:([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
    const ogRegexAlt = /<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:([^"']+)["'][^>]*>/gi;
    let ogMatch;
    while ((ogMatch = ogRegex.exec(html)) !== null) {
      result.open_graph[ogMatch[1]] = ogMatch[2];
    }
    while ((ogMatch = ogRegexAlt.exec(html)) !== null) {
      result.open_graph[ogMatch[2]] = ogMatch[1];
    }

    // Extract Twitter Card tags
    const twRegex = /<meta[^>]*name=["']twitter:([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
    const twRegexAlt = /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']twitter:([^"']+)["'][^>]*>/gi;
    let twMatch;
    while ((twMatch = twRegex.exec(html)) !== null) {
      result.twitter_card[twMatch[1]] = twMatch[2];
    }
    while ((twMatch = twRegexAlt.exec(html)) !== null) {
      result.twitter_card[twMatch[2]] = twMatch[1];
    }

    // Extract JSON-LD structured data
    const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let jsonLdMatch;
    while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(jsonLdMatch[1].trim());
        result.structured_data.push(data);
        if (data["@type"]) {
          const types = Array.isArray(data["@type"]) ? data["@type"] : [data["@type"]];
          result.schema_types.push(...types.filter((t: any) => typeof t === 'string'));
        }
        if (data["@graph"] && Array.isArray(data["@graph"])) {
          for (const item of data["@graph"]) {
            if (item["@type"]) {
              const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
              result.schema_types.push(...types.filter((t: any) => typeof t === 'string'));
            }
          }
        }
        if (Array.isArray(data) && data.length > 0 && data[0]["@type"]) {
          const types = Array.isArray(data[0]["@type"]) ? data[0]["@type"] : [data[0]["@type"]];
          result.schema_types.push(...types.filter((t: any) => typeof t === 'string'));
        }
      } catch (e) {
        // Invalid JSON-LD, skip
      }
    }
    // Deduplicate schema types
    result.schema_types = [...new Set(result.schema_types)];

    // Extract JS and CSS counts
    const jsMatches = html.match(/<script[^>]*src=/gi);
    result.js_count = jsMatches ? jsMatches.length : 0;
    const cssMatches = html.match(/<link[^>]*rel=["']stylesheet["']/gi);
    result.css_count = cssMatches ? cssMatches.length : 0;

    // Check for viewport meta tag
    result.has_viewport_meta = /<meta[^>]*name=["']viewport["']/i.test(html);

    // Check for mixed content (HTTPS page with HTTP resources)
    if (result.url.startsWith("https://")) {
      const mixedContentPatterns = [
        /<img[^>]*src=["']http:\/\//i,
        /<script[^>]*src=["']http:\/\//i,
        /<link[^>]*href=["']http:\/\//i,
        /<iframe[^>]*src=["']http:\/\//i,
        /<video[^>]*src=["']http:\/\//i,
        /<audio[^>]*src=["']http:\/\//i,
        /<source[^>]*src=["']http:\/\//i,
        /<object[^>]*data=["']http:\/\//i,
        /<embed[^>]*src=["']http:\/\//i,
      ];
      result.has_mixed_content = mixedContentPatterns.some((pattern) => pattern.test(html));
    } else {
      result.has_mixed_content = false;
    }

    // Extract hreflang tags
    const hreflangRegex = /<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']*)["'][^>]*href=["']([^"']*)["'][^>]*>/gi;
    const hreflangRegexAlt = /<link[^>]*hreflang=["']([^"']*)["'][^>]*rel=["']alternate["'][^>]*href=["']([^"']*)["'][^>]*>/gi;
    const hreflangRegexAlt2 = /<link[^>]*href=["']([^"']*)["'][^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']*)["'][^>]*>/gi;
    result.hreflang_tags = [];
    let hreflangMatch;
    while ((hreflangMatch = hreflangRegex.exec(html)) !== null) {
      result.hreflang_tags.push({ lang: hreflangMatch[1], url: hreflangMatch[2] });
    }
    while ((hreflangMatch = hreflangRegexAlt.exec(html)) !== null) {
      result.hreflang_tags.push({ lang: hreflangMatch[1], url: hreflangMatch[2] });
    }
    while ((hreflangMatch = hreflangRegexAlt2.exec(html)) !== null) {
      result.hreflang_tags.push({ lang: hreflangMatch[2], url: hreflangMatch[1] });
    }

    // Check canonical_is_self
    result.canonical_is_self = this.checkCanonicalIsSelf(result.canonical_url, result.url);

    // Check URL issues
    result.url_issues = this.analyzeUrlIssues(result.url);

    // Check heading hierarchy
    const hierarchyResult = this.checkHeadingHierarchy(result);
    result.heading_hierarchy_valid = hierarchyResult.valid;
    result.heading_hierarchy_issues = hierarchyResult.issues;

    // Detect contact forms
    result.has_contact_form = this.detectContactForm(html);

    // CLS risk: images without explicit width/height
    result.cls_risk_images = (() => {
      const imgRegex = /<img\s[^>]*>/gi;
      let count = 0;
      let m;
      while ((m = imgRegex.exec(html)) !== null) {
        const tag = m[0];
        if (!(/width=["']?\d/.test(tag) && /height=["']?\d/.test(tag))) count++;
      }
      return count;
    })();

    // Accessibility (limited via regex)
    result.accessibility = {
      html_lang: (html.match(/<html[^>]*\slang=["']([^"']+)["']/i) || [])[1] || undefined,
      form_labels_missing: 0,
      aria_landmarks: (() => {
        const landmarks = new Set<string>();
        if (/<nav[\s>]/i.test(html)) landmarks.add("nav");
        if (/<main[\s>]/i.test(html)) landmarks.add("main");
        if (/<header[\s>]/i.test(html)) landmarks.add("header");
        if (/<footer[\s>]/i.test(html)) landmarks.add("footer");
        if (/<aside[\s>]/i.test(html)) landmarks.add("aside");
        return [...landmarks];
      })(),
      has_skip_nav: /href=["']#[^"']*["'][^>]*>[^<]*(skip|jump to)/i.test(html),
      tabindex_misuse: 0,
    };

    // Cookie consent detection
    result.has_cookie_consent = /cookie[-_]?(banner|consent|notice|policy|popup)|gdpr|onetrust|cookiebot|cc-banner/i.test(html);

    // Resource hints
    result.resource_hints = (() => {
      const extract = (rel: string) => {
        const re = new RegExp(`<link[^>]*rel=["']${rel}["'][^>]*href=["']([^"']+)["']`, "gi");
        const reAlt = new RegExp(`<link[^>]*href=["']([^"']+)["'][^>]*rel=["']${rel}["']`, "gi");
        const urls: string[] = [];
        let m;
        while ((m = re.exec(html)) !== null) urls.push(m[1]);
        while ((m = reAlt.exec(html)) !== null) urls.push(m[1]);
        return urls;
      };
      return {
        preconnect: extract("preconnect"),
        preload: extract("preload"),
        prefetch: extract("prefetch"),
        dns_prefetch: extract("dns-prefetch"),
      };
    })();

    // Fetch image file sizes (background, non-blocking)
    await this.fetchImageFileSizes(result.images);
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
    const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const text = match[2].replace(/<[^>]+>/g, "").trim();

      const hrefLower = (href || "").trim().toLowerCase();
      if (
        !href ||
        href === "#" ||
        hrefLower.startsWith("javascript:") ||
        hrefLower.startsWith("mailto:") ||
        hrefLower.startsWith("tel:") ||
        hrefLower.startsWith("data:") ||
        hrefLower.startsWith("ftp:") ||
        hrefLower.startsWith("sms:") ||
        hrefLower.startsWith("blob:") ||
        hrefLower.startsWith("file:") ||
        hrefLower.startsWith("geo:") ||
        hrefLower.startsWith("whatsapp:") ||
        hrefLower.startsWith("skype:") ||
        hrefLower.startsWith("viber:") ||
        hrefLower.startsWith("callto:")
      ) continue;

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
        const widthMatch = match[0].match(/width=["']?(\d+)/i);
        const heightMatch = match[0].match(/height=["']?(\d+)/i);
        const loadingMatch = match[0].match(/loading=["']([^"']*)["']/i);
        const srcsetMatch = match[0].match(/srcset=["']([^"']*)["']/i);

        result.images.push({
          src: resolvedUrl,
          alt: altMatch ? altMatch[1] : "",
          dimensions: {
            width: widthMatch ? parseInt(widthMatch[1], 10) : 0,
            height: heightMatch ? parseInt(heightMatch[1], 10) : 0,
          },
          loading: loadingMatch ? loadingMatch[1] : "",
          srcset: srcsetMatch ? srcsetMatch[1] : undefined,
          format: this.deriveImageFormat(resolvedUrl),
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

  private detectContactForm(html: string): boolean {
    const formRegex = /<form[\s\S]*?<\/form>/gi;
    let match;
    while ((match = formRegex.exec(html)) !== null) {
      const form = match[0].toLowerCase();
      const hasEmailInput = /type=["']email["']|name=["'][^"']*email[^"']*["']|autocomplete=["']email["']/.test(form);
      const hasTextarea = /<textarea/.test(form);
      const hasPhoneInput = /type=["']tel["']|name=["'][^"']*phone[^"']*["']/.test(form);
      const hasNameInput = /name=["'][^"']*name[^"']*["']|autocomplete=["']name["']/.test(form);
      if (hasEmailInput && (hasTextarea || hasPhoneInput || hasNameInput)) return true;
    }
    return false;
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
      redirect_chain: [],
      content_type: "",
      size_bytes: 0,
      load_time_ms: 0,
      first_byte_time_ms: 0,
      security_headers: {},
      has_viewport_meta: false,
      has_mixed_content: false,
      structured_data: [],
      schema_types: [],
      js_count: 0,
      css_count: 0,
      keywords: [],
      heading_hierarchy_valid: true,
      heading_hierarchy_issues: [],
      hreflang_tags: [],
      canonical_is_self: false,
      url_issues: [],
      content_hash: undefined,
      readability_score: undefined,
      scan_method: "http",
      scanned_at: new Date().toISOString(),
      errors: [],
      warnings: [],
    };
  }

  private extractKeywords(text: string): Array<{ word: string; count: number }> {
    const stopWords = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
      "her", "was", "one", "our", "out", "has", "its", "let", "say", "she",
      "too", "use", "that", "with", "this", "have", "from", "they", "been",
      "said", "each", "make", "like", "long", "look", "many", "some", "than",
      "them", "then", "what", "when", "will", "more", "into", "over", "such",
      "take", "also", "back", "came", "come", "just", "only", "very", "well",
      "your", "were", "which", "about", "after", "being", "could", "every",
      "first", "found", "great", "their", "there", "these", "those", "under",
      "where", "while", "would", "other", "still", "between", "should", "through",
    ]);

    const words = text.toLowerCase().match(/[\p{L}]{4,}/gu) || [];
    const freq = new Map<string, number>();
    for (const word of words) {
      if (!stopWords.has(word)) {
        freq.set(word, (freq.get(word) || 0) + 1);
      }
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, count]) => ({ word, count }));
  }

  /**
   * Extract security-relevant headers from a Puppeteer HTTP response.
   */
  private extractSecurityHeaders(headers: Record<string, string>): Record<string, string> {
    const securityHeaderNames = [
      "content-security-policy",
      "strict-transport-security",
      "x-frame-options",
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
    ];
    const result: Record<string, string> = {};
    for (const name of securityHeaderNames) {
      const value = headers[name];
      if (value) {
        result[name] = value;
      }
    }
    return result;
  }

  /**
   * Extract security-relevant headers from a fetch Response.
   */
  private extractSecurityHeadersFromFetch(headers: Headers): Record<string, string> {
    const securityHeaderNames = [
      "content-security-policy",
      "strict-transport-security",
      "x-frame-options",
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
    ];
    const result: Record<string, string> = {};
    for (const name of securityHeaderNames) {
      const value = headers.get(name);
      if (value) {
        result[name] = value;
      }
    }
    return result;
  }

  /**
   * Derive image format from the URL file extension.
   */
  private deriveImageFormat(url: string): string {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const extMatch = pathname.match(/\.([a-z0-9]+)(?:\?.*)?$/);
      if (extMatch) {
        const ext = extMatch[1];
        const formatMap: Record<string, string> = {
          jpg: "jpeg",
          jpeg: "jpeg",
          png: "png",
          gif: "gif",
          webp: "webp",
          avif: "avif",
          svg: "svg",
          ico: "ico",
          bmp: "bmp",
          tiff: "tiff",
          tif: "tiff",
        };
        return formatMap[ext] || ext;
      }
    } catch {
      // Invalid URL
    }
    return "";
  }

  /**
   * Check if the canonical URL matches the page's own URL (normalized comparison).
   */
  private checkCanonicalIsSelf(canonical: string | null, pageUrl: string): boolean {
    if (!canonical) return false;
    try {
      const normalizeForComparison = (u: string): string => {
        const parsed = new URL(u);
        // Normalize: lowercase host, remove trailing slash, remove default ports
        let normalized = parsed.protocol + "//" + parsed.host.toLowerCase() + parsed.pathname.replace(/\/+$/, "") + parsed.search;
        return normalized.toLowerCase();
      };
      return normalizeForComparison(canonical) === normalizeForComparison(pageUrl);
    } catch {
      // If URL parsing fails, do simple string comparison
      return canonical === pageUrl;
    }
  }

  /**
   * Analyze the URL for common SEO issues.
   */
  private analyzeUrlIssues(url: string): string[] {
    const issues: string[] = [];
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname;

      // Check for uppercase letters in the path
      if (/[A-Z]/.test(pathname)) {
        issues.push("URL contains uppercase letters");
      }

      // Check for underscores instead of hyphens
      if (pathname.includes("_")) {
        issues.push("URL contains underscores instead of hyphens");
      }

      // Check for excessive length (> 115 chars for full URL)
      if (url.length > 115) {
        issues.push(`URL is excessively long (${url.length} characters, recommended max 115)`);
      }

      // Check for dynamic parameters
      if (parsed.search) {
        issues.push("URL contains dynamic query parameters");
      }
    } catch {
      // Invalid URL, skip analysis
    }
    return issues;
  }

  /**
   * Check heading hierarchy for skipped levels.
   */
  private checkHeadingHierarchy(result: ScanResult): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    const levels = [
      { level: 1, headings: result.h1s },
      { level: 2, headings: result.h2s },
      { level: 3, headings: result.h3s },
      { level: 4, headings: result.h4s },
      { level: 5, headings: result.h5s },
      { level: 6, headings: result.h6s },
    ];

    // Find which heading levels are present
    const presentLevels = levels
      .filter((l) => l.headings.length > 0)
      .map((l) => l.level);

    // Check for skipped levels between the lowest and highest present
    if (presentLevels.length >= 2) {
      for (let i = 0; i < presentLevels.length - 1; i++) {
        const current = presentLevels[i];
        const next = presentLevels[i + 1];
        if (next - current > 1) {
          const skipped: string[] = [];
          for (let s = current + 1; s < next; s++) {
            skipped.push(`H${s}`);
          }
          issues.push(`Heading level skipped: H${current} to H${next} (missing ${skipped.join(", ")})`);
        }
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Compute a SHA-256 hash of the main text content for duplicate detection.
   */
  private computeContentHash(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    return createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Compute Flesch Reading Ease score.
   * Higher = easier to read (60-70 is ideal for web content).
   */
  private computeReadabilityScore(text: string): number {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const syllables = words.reduce((sum, w) => sum + this.countSyllables(w), 0);

    if (sentences.length === 0 || words.length === 0) return 0;

    const avgWordsPerSentence = words.length / sentences.length;
    const avgSyllablesPerWord = syllables / words.length;

    const score = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private countSyllables(word: string): number {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (w.length <= 3) return 1;
    const vowelGroups = w.match(/[aeiouy]+/g);
    let count = vowelGroups ? vowelGroups.length : 1;
    if (w.endsWith("e")) count--;
    if (w.endsWith("le") && w.length > 2 && !/[aeiouy]/.test(w[w.length - 3])) count++;
    return Math.max(1, count);
  }

  /**
   * Fetch file sizes for images via HEAD requests (limited to first N images).
   */
  private async fetchImageFileSizes(
    images: ScanResult["images"],
    limit: number = 10,
  ): Promise<void> {
    const toCheck = images.slice(0, limit);
    const promises = toCheck.map(async (img) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(img.src, {
          method: "HEAD",
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });
        clearTimeout(timeout);
        const cl = resp.headers.get("content-length");
        if (cl) {
          img.file_size_bytes = parseInt(cl, 10);
        }
      } catch {
        // Skip — file size unknown
      }
    });
    await Promise.allSettled(promises);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
