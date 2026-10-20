import { createHash } from "crypto";
import { decodeHTML } from "entities";
import { ScanResult } from "../types";
import { UrlProcessor, isPublicUrl, isSelfCanonical } from "../utils/url";
import { isJavaScriptHeavySite, getSharedBrowserPool, detectPlatformFromHeaders, detectPlatformFromHtml, platformNeedsHeadless } from "../utils/browser";
import { proxyFetch, getProxyCredentials, isProxyConfigured } from "../utils/proxy";
import { USER_AGENT } from "../config/identity";
import { Page } from "puppeteer";
import { extractFromHtml, deriveCleanTitle } from "./extract/parse-html";
import { isSoft404 } from "./extract/soft404";

/** Decode HTML entities in every value of a string record (OG / Twitter tags). */
function decodeStringRecord(
  record: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = typeof v === "string" ? decodeHTML(v) : v;
  }
  return out;
}

export class Scanner {
  private userAgent = USER_AGENT;

  async scan(
    url: string,
    depth: number,
    forceHeadless: boolean = false,
  ): Promise<ScanResult> {
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
      // headlessScan sets load_time_ms to the real navigation time.
      return await this.headlessScan(url, depth);
    }

    // Try HTTP first for simple sites
    let result = await this.httpScan(url, depth);

    // If the direct request was blocked by bot protection and a proxy is
    // available, retry just this request through the proxy. Done as a fallback
    // (not for every request) so residential-proxy bandwidth is only spent on
    // sites that actually block us. PROXY_ALWAYS already routed the first try
    // through the proxy, so there's nothing more to fall back to.
    if (
      (result as any)._isBotChallenge &&
      isProxyConfigured() &&
      process.env.PROXY_ALWAYS !== "true"
    ) {
      console.log(`🛡️ Direct request blocked for ${url} — retrying via proxy`);
      const proxied = await this.httpScan(url, depth, true);
      if (!(proxied as any)._isBotChallenge) {
        console.log(`✅ Proxy bypassed bot protection for ${url}`);
        result = proxied;
      }
    }

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
      const blockedIp = (result as any)._challengeIp;
      const blockedMsg = blockedIp
        ? `Blocked by bot protection / WAF challenge page (blocked IP ${blockedIp})`
        : "Blocked by bot protection / WAF challenge page";
      result.errors = [...(result.errors || []), blockedMsg];
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

    // Persist the detected platform (the temp fields below are about to be
    // cleared). The HTTP-derived detection covers Shopify/WordPress even when
    // the final result came from the headless pass.
    result.detected_platform = detectedPlatform || null;

    // For an HTTP-final result we only ever saw the raw server HTML, so any
    // schema found is server-rendered by definition. (The headless path sets
    // schema_source itself, distinguishing server/client/both.)
    if (result.scan_method === "http" && !result.schema_source) {
      result.schema_source =
        (result.schema_types?.length ?? 0) > 0 ? "server" : "none";
    }

    // Clean up internal fields
    delete (result as any)._detectedPlatform;
    delete (result as any)._rawHtml;
    delete (result as any)._isBotChallenge;
    delete (result as any)._challengeIp;

    // load_time_ms is set inside httpScan / headlessScan to the real document
    // load time. scan() no longer overwrites it with whole-scan wall-clock,
    // which previously also counted proxy retries, the HTTP->headless double
    // fetch, image HEAD requests, and our own analysis.
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

      // Authenticate with proxy if configured
      const proxyCreds = getProxyCredentials();
      if (proxyCreds) {
        await page.authenticate(proxyCreds);
      }

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
      // Real load time: navigation through DOMContentLoaded. Excludes the
      // dynamic-content wait and extraction below, which are our processing.
      result.load_time_ms = Date.now() - navigateStart;

      result.status = response?.status() || 0;
      result.url = urlProcessor.normalize(page.url());

      // Raw server HTML (before client JS runs). Captured now so we can later
      // tell whether JSON-LD is server-rendered or injected on the client.
      const rawServerHtml = response
        ? await response.text().catch(() => "")
        : "";

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

      // Check for bot challenge pages (Cloudflare, SiteGround, etc.) — these
      // often have no title and just a meta-refresh, so inspect HTML too
      const challengeTitle = await page.title();
      const challengeHtml = await page.content().catch(() => "");
      if (this.isBotChallengePage(challengeTitle, challengeHtml)) {
        console.log(`🛡️ Bot challenge detected for ${url}, brief wait for auto-resolution...`);
        await this.delay(3000);
        const postChallengeTitle = await page.title();
        const postChallengeHtml = await page.content().catch(() => "");
        if (this.isBotChallengePage(postChallengeTitle, postChallengeHtml)) {
          console.log(`🚫 Bot challenge still present for ${url} — marking as blocked`);
          result.errors = [...(result.errors || []), "Blocked by bot protection / WAF challenge page"];
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

      // Render transparency: is the JSON-LD in the raw server HTML, or only
      // present after the client render? "client" means Google may not see it.
      const rawHasSchema = /application\/ld\+json/i.test(rawServerHtml);
      const renderedHasSchema =
        (result.schema_types?.length ?? 0) > 0 ||
        (result.structured_data?.length ?? 0) > 0;
      result.schema_source = rawHasSchema
        ? (renderedHasSchema ? "both" : "server")
        : (renderedHasSchema ? "client" : "none");

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
    // Title stored verbatim (P-01); cleaned form is a separate derived field.
    const rawTitle = await this.extractTitleVerbatim(page);
    result.title = rawTitle;
    result.title_cleaned = deriveCleanTitle(rawTitle);

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
    result.lead_paragraph_words = contentStats.leadParagraphWords;

    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    result.keywords = this.extractKeywords(bodyText);
    result.content_hash = this.computeContentHash(bodyText);
    result.readability_score = this.computeReadabilityScore(bodyText);

    // Extract meta tags
    const metaTags = await this.extractMetaTags(page);
    result.open_graph = decodeStringRecord(metaTags.openGraph);
    result.twitter_card = decodeStringRecord(metaTags.twitterCard);
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
    result.script_srcs = techData.scriptSrcs;
    result.stylesheet_hrefs = techData.stylesheetHrefs;
    result.structured_data = techData.structuredData;
    result.schema_types = techData.schemaTypes;

    // Check for viewport meta tag
    result.has_viewport_meta = await page.evaluate(() => {
      return !!document.querySelector('meta[name="viewport"]');
    });

    // Extract the declared favicon (covers Shopify, which links its icon from
    // cdn.shopify.com rather than serving /favicon.ico at the root).
    result.favicon_url = await page.evaluate(() => {
      const link = document.querySelector(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]',
      ) as HTMLLinkElement | null;
      return link?.href || null;
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

    // Soft-404: a 2xx response whose title/H1 reads as "not found" (S-01).
    result.soft_404 = isSoft404(result.status, result.title, result.h1s);

    // Mark as headless scan
    result.scan_method = "headless";
  }

  /**
   * The page's title, VERBATIM (P-01). document.title is already the parsed,
   * entity-decoded <title>. Fall back to og:title then the first H1 only when
   * there is no <title>. No brand-suffix stripping and no payment-provider
   * filtering of a real title — the cleaned form is a separate derived field
   * (title_cleaned). Matches the HTTP path's extractFromHtml title behaviour.
   */
  private async extractTitleVerbatim(page: Page): Promise<string> {
    try {
      const docTitle = ((await page.title()) || "").trim();
      if (docTitle) return docTitle;
      const og = await page
        .$eval('meta[property="og:title"]', (el) => el.getAttribute("content"))
        .catch(() => null);
      if (og && og.trim()) return og.trim();
      const h1 = await page
        .$eval("h1", (el) => el.textContent?.trim() || "")
        .catch(() => null);
      return (h1 || "").trim();
    } catch {
      return "";
    }
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
  ): Promise<{
    contentLength: number;
    wordCount: number;
    leadParagraphWords: number;
  }> {
    try {
      return await page.evaluate(() => {
        const countWords = (text: string) =>
          text
            .trim()
            .split(/\s+/)
            .filter((w) => w.length > 0).length;

        // Word count should reflect the MAIN CONTENT, not nav/header/footer
        // boilerplate — otherwise a Divi header+footer alone reads as ~150 words
        // and thin, real pages get falsely flagged. Prefer an explicit content
        // container; fall back to the body with chrome removed.
        const mainSelectors = [
          "main",
          "article",
          "[role=main]",
          ".entry-content",
          ".post-content",
          ".article-content",
          ".et_pb_post_content",
          "#content",
          "#main",
        ];
        let contentEl: HTMLElement | null = null;
        for (const sel of mainSelectors) {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && (el.textContent || "").trim().length > 200) {
            contentEl = el;
            break;
          }
        }

        const source = (contentEl || document.body).cloneNode(
          true,
        ) as HTMLElement;
        source
          .querySelectorAll(
            "script, style, noscript, nav, header, footer, aside, form," +
              "[role=navigation], [role=banner], [role=contentinfo]," +
              ".nav, .navbar, .menu, .sidebar, .widget, .footer, .site-footer, .site-header, .header",
          )
          .forEach((el) => el.remove());
        const contentText = source.textContent || "";

        // contentLength stays a whole-page proxy (used as a page-size signal).
        const fullClone = document.body.cloneNode(true) as HTMLElement;
        fullClone
          .querySelectorAll("script, style, noscript")
          .forEach((el) => el.remove());
        const fullText = fullClone.textContent || "";

        // Answer block: the first substantial paragraph at the top of the main
        // content (ideally right after the H1). AEO best practice is to lead
        // with a direct answer; 0 here means the page opens with no lead prose.
        let leadParagraphWords = 0;
        const scope = contentEl || document.body;
        const h1 = scope.querySelector("h1");
        const paragraphs = Array.from(scope.querySelectorAll("p"));
        const h1Top = h1 ? h1.getBoundingClientRect().top : -Infinity;
        for (const p of paragraphs) {
          // Only consider paragraphs at/after the H1, and near the top.
          if (h1 && p.getBoundingClientRect().top < h1Top) continue;
          const w = countWords(p.textContent || "");
          if (w >= 10) {
            leadParagraphWords = w;
            break;
          }
        }

        return {
          contentLength: fullText.length,
          wordCount: countWords(contentText),
          leadParagraphWords,
        };
      });
    } catch (error) {
      return { contentLength: 0, wordCount: 0, leadParagraphWords: 0 };
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
          // img.alt returns "" for BOTH a missing attribute and alt="", so
          // capture attribute presence explicitly to tell them apart.
          hasAlt: img.hasAttribute("alt"),
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
            alt_state: !img.hasAlt
              ? "absent"
              : img.alt.trim() === ""
                ? "empty"
                : "present",
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
    scriptSrcs: string[];
    stylesheetHrefs: string[];
    structuredData: any[];
    schemaTypes: string[];
  }> {
    try {
      return await page.evaluate(() => {
        // Real, browser-resolved asset URLs for framework/CMS detection.
        const scriptSrcs = Array.from(
          document.querySelectorAll("script[src]"),
        ).map((s) => (s as HTMLScriptElement).src);
        const stylesheetHrefs = Array.from(
          document.querySelectorAll('link[rel="stylesheet"]'),
        ).map((l) => (l as HTMLLinkElement).href);
        const jsCount = scriptSrcs.length;
        const cssCount = stylesheetHrefs.length;

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
          scriptSrcs,
          stylesheetHrefs,
          structuredData,
          schemaTypes: [...new Set(schemaTypes)], // Remove duplicates
        };
      });
    } catch (error) {
      return {
        jsCount: 0,
        cssCount: 0,
        scriptSrcs: [],
        stylesheetHrefs: [],
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
        // Cloudflare
        "cf-browser-verification",
        "challenge-platform",
        "cf-turnstile",
        "__cf_chl_opt",
        "cf-challenge-running",
        "cdn-cgi/challenge-platform",
        "managed-challenge",
        "ray ID",
        // SiteGround
        "/.well-known/sgcaptcha",
        "sgcaptcha",
        // Sucuri / Imperva (Incapsula) / Distil
        "sucuri_cloudproxy",
        "_incapsula_resource",
        "incident_id",
        "distil_r_captcha",
      ];
      const lower = html.toLowerCase();
      if (challengeMarkers.some(m => lower.includes(m))) {
        return true;
      }
      // Tiny page that's just a meta-refresh into a captcha/challenge endpoint
      // (SiteGround returns this with a 202) — no real content, never a page
      if (
        html.length < 1500 &&
        /http-equiv=["']?refresh/i.test(html) &&
        /captcha|challenge|\.well-known/i.test(html)
      ) {
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

  private async httpScan(
    url: string,
    depth: number,
    useProxy: boolean = false,
  ): Promise<ScanResult> {
    const urlProcessor = new UrlProcessor(url);
    const result = this.createBaseScanResult(url, depth);

    const maxRetries = 3;
    let lastError: Error | null = null;
    // Flipped on when the site presents an incomplete certificate chain, so the
    // next attempt retries with TLS chain verification relaxed instead of
    // failing all retries and forcing every page down the slow headless path.
    let insecureTLS = false;

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

          response = await proxyFetch(currentUrl, {
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
          }, { useProxy, insecureTLS });

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
          result.load_time_ms = Date.now() - fetchStart;
          return result;
        }

        const html = await response.text();
        clearTimeout(timeoutId);
        // Real load time: first byte through full body download. Everything
        // after this (HTML parsing, image HEADs, readability) is our analysis
        // and must not count toward the page's load time.
        result.load_time_ms = Date.now() - fetchStart;
        result.size_bytes = new TextEncoder().encode(html).length;

        await this.processHtml(result, html, urlProcessor);
        result.scan_method = "http";
        // Attach raw HTML temporarily for platform detection in scan()
        (result as any)._rawHtml = html;
        // Flag bot challenge pages for headless escalation
        if (this.isBotChallengePage(result.title, html)) {
          (result as any)._isBotChallenge = true;
          // SiteGround's challenge embeds the blocked IP (ipc:1.2.3.4) — capture
          // it so we can tell the customer exactly which IP to allowlist
          const ipMatch = html.match(/ipc:(\d{1,3}(?:\.\d{1,3}){3})/i);
          if (ipMatch) (result as any)._challengeIp = ipMatch[1];
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

        // Incomplete certificate chain (missing intermediate): the site's TLS is
        // otherwise valid but Node can't build the chain. Retry once with chain
        // verification relaxed rather than burning all retries + a headless pass.
        const tlsChainError =
          /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_UNTRUSTED/i.test(
            String(rootCause?.code || ""),
          ) ||
          /unable to verify the first certificate|self.signed certificate in certificate chain/i.test(
            detail,
          );
        if (tlsChainError && !insecureTLS) {
          insecureTLS = true;
          result.tls_chain_incomplete = true;
          console.log(
            `🔐 Incomplete TLS certificate chain for ${url} — retrying without chain verification`,
          );
          continue; // immediate retry, no backoff
        }

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
    // Single DOM-string extraction path (P-06): cheerio parses the raw HTML and
    // fills every DOM-derivable field, with the parser-level correctness fixes
    // baked in (see src/services/extract/parse-html.ts). Replaces the old
    // per-field regex extraction that lived here.
    const parsed = extractFromHtml(html, result.url);

    result.title = parsed.title ?? "";
    result.title_cleaned = parsed.title_cleaned;
    if (parsed.meta_description !== undefined) result.meta_description = parsed.meta_description;
    result.favicon_url = parsed.favicon_url ?? null;

    result.h1s = parsed.h1s ?? [];
    result.h2s = parsed.h2s ?? [];
    result.h3s = parsed.h3s ?? [];
    result.h4s = parsed.h4s ?? [];
    result.h5s = parsed.h5s ?? [];
    result.h6s = parsed.h6s ?? [];
    result.heading_hierarchy_valid = parsed.heading_hierarchy_valid ?? true;
    result.heading_hierarchy_issues = parsed.heading_hierarchy_issues ?? [];

    result.internal_links = parsed.internal_links ?? [];
    result.external_links = parsed.external_links ?? [];
    result.images = parsed.images ?? [];

    result.content_length = parsed.content_length ?? 0;
    result.word_count = parsed.word_count ?? 0;
    result.lead_paragraph_words = parsed.lead_paragraph_words ?? 0;
    result.content_hash = parsed.content_hash;
    result.readability_score = parsed.readability_score;
    result.keywords = parsed.keywords ?? [];

    result.canonical_url = parsed.canonical_url ?? null;
    result.canonical_urls = parsed.canonical_urls;
    result.canonical_is_self = isSelfCanonical(result.canonical_url, result.url);

    // Robots: merge the meta signal with any X-Robots-Tag header already applied
    // in httpScan (header noindex must not be cleared by a permissive meta).
    result.has_robots_noindex = result.has_robots_noindex || !!parsed.meta_noindex;
    result.has_robots_nofollow = result.has_robots_nofollow || !!parsed.meta_nofollow;
    result.is_indexable = !result.has_robots_noindex;

    result.open_graph = parsed.open_graph ?? {};
    result.twitter_card = parsed.twitter_card ?? {};
    result.structured_data = parsed.structured_data ?? [];
    result.schema_types = parsed.schema_types ?? [];
    result.has_invalid_structured_data = parsed.has_invalid_structured_data;

    result.script_srcs = parsed.script_srcs ?? [];
    result.js_count = parsed.js_count ?? 0;
    result.stylesheet_hrefs = parsed.stylesheet_hrefs ?? [];
    result.css_count = parsed.css_count ?? 0;

    result.has_viewport_meta = parsed.has_viewport_meta ?? false;
    result.has_mixed_content = parsed.has_mixed_content ?? false;
    result.hreflang_tags = parsed.hreflang_tags ?? [];
    result.url_issues = parsed.url_issues ?? [];
    result.has_contact_form = parsed.has_contact_form ?? false;
    result.cls_risk_images = parsed.cls_risk_images ?? 0;
    result.accessibility = parsed.accessibility;
    result.has_cookie_consent = parsed.has_cookie_consent ?? false;
    result.resource_hints = parsed.resource_hints;

    // Soft-404: a 2xx response whose title/H1 reads as "not found" (S-01).
    result.soft_404 = isSoft404(result.status, result.title, result.h1s);

    // Network step (not pure): probe image file sizes.
    await this.fetchImageFileSizes(result.images);
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

    // Safety net: even though text is entity-decoded upstream, never let an
    // HTML entity name leak through as a "keyword" (e.g. rsquo, nbsp, amp).
    const entityNames = new Set([
      "amp", "lt", "gt", "quot", "apos", "nbsp", "rsquo", "lsquo", "rdquo",
      "ldquo", "ndash", "mdash", "hellip", "copy", "reg", "trade", "deg",
      "middot", "bull", "dagger", "laquo", "raquo", "hearts", "frac",
    ]);

    const words = text.toLowerCase().match(/[\p{L}]{4,}/gu) || [];
    const freq = new Map<string, number>();
    for (const word of words) {
      if (!stopWords.has(word) && !entityNames.has(word)) {
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
    // Resolves relative canonicals against the page URL before comparing, so a
    // self-referential relative canonical (href="/about") isn't a false mismatch.
    return isSelfCanonical(canonical, pageUrl);
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
        // SSRF guard: img.src comes from the scanned page, so it could point at
        // a private/internal host. Only HEAD public URLs (same guard the primary
        // fetch uses).
        if (!(await isPublicUrl(img.src))) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await proxyFetch(img.src, {
          method: "HEAD",
          signal: controller.signal,
          headers: {
            "User-Agent": this.userAgent,
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
