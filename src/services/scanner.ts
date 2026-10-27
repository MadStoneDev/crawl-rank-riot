import { ScanResult } from "../types";
import { UrlProcessor, isPublicUrl, isSelfCanonical, normalizeForSelfCompare } from "../utils/url";
import { isJavaScriptHeavySite, getSharedBrowserPool, detectPlatformFromHeaders, detectPlatformFromHtml, platformNeedsHeadless } from "../utils/browser";
import { proxyFetch, getProxyCredentials, isProxyConfigured } from "../utils/proxy";
import { USER_AGENT } from "../config/identity";
import { Page } from "puppeteer";
import { extractFromHtml, applyParsedHtml, isHtmlContentType, decodeHtmlBody, parseLinkHeaderCanonical } from "./extract/parse-html";

/** Upper bound on HTML bytes we parse per page (E-02). Real pages are a tiny
 * fraction of this; the cap only guards against pathological runaway documents. */
const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Below this HTTP word count, a page on a client-rendered platform is assumed
 * to be a shell (nav + cookie banner) rather than real content, so we escalate
 * to headless (J-01). Real content pages on these platforms comfortably exceed
 * it; the "keep HTTP unless headless is better" guard downstream protects the
 * rare genuinely-thin page from a worse headless result.
 */
const SPA_SHELL_WORD_COUNT = 200;

/**
 * Decide whether an HTTP scan result is too poor to trust and should be
 * re-fetched with a headless browser. Pure so it is unit-testable (J-01).
 */
export function needsHeadlessEscalation(
  result: Pick<ScanResult, "title" | "content_type" | "content_length" | "word_count" | "is_non_html">,
  platform: string | null,
): boolean {
  // A non-HTML resource (PDF, feed, image …) is tracked, not rendered. It has
  // no title/content by design, so never escalate it to headless (S-02).
  if (result.is_non_html) return false;

  // No title at all — likely JS-rendered SPA.
  if (!result.title || result.title.length < 3) return true;

  const isHtml = !!result.content_type?.includes("text/html");

  // Almost no text content — page body is probably rendered by JS.
  if (isHtml && (result.content_length ?? 0) < 500 && (result.word_count ?? 0) < 5) {
    return true;
  }

  // Client-rendered platform (Shopify/Squarespace/Wix/SPA …): a shell can clear
  // the thin-content bar above with just nav + a cookie notice while hiding the
  // real, client-rendered content, links and schema. Escalate unless the HTTP
  // response already captured substantial content (J-01).
  if (isHtml && platformNeedsHeadless(platform) && (result.word_count ?? 0) < SPA_SHELL_WORD_COUNT) {
    return true;
  }

  return false;
}

/** The SSRF guard used before every fetch. Production always uses the strict
 * `isPublicUrl`; only tests inject a permissive one (see ScannerDeps). */
export type UrlGuard = (url: string) => Promise<boolean>;
/** The network fetch used for HTTP scans and image probes. Defaults to the
 * real `proxyFetch`; injectable for fetch-layer integration tests. */
export type FetchImpl = typeof proxyFetch;

/**
 * Injectable dependencies for the Scanner. Both default to the strict
 * production implementations, so a Scanner constructed the normal way
 * (`new Scanner()`) behaves exactly as before and can never relax the SSRF
 * guard. Only test code passes overrides — e.g. a guard that permits a local
 * fixture server on 127.0.0.1. There is deliberately no env var or runtime flag
 * that swaps these out, so no production code path can loosen the guard.
 */
export interface ScannerDeps {
  urlGuard?: UrlGuard;
  fetchImpl?: FetchImpl;
}

export class Scanner {
  private userAgent = USER_AGENT;
  private urlGuard: UrlGuard;
  private fetchImpl: FetchImpl;

  constructor(deps: ScannerDeps = {}) {
    this.urlGuard = deps.urlGuard ?? isPublicUrl;
    this.fetchImpl = deps.fetchImpl ?? proxyFetch;
  }

  async scan(
    url: string,
    depth: number,
    forceHeadless: boolean = false,
  ): Promise<ScanResult> {
    // SSRF protection: block requests to private/reserved IP ranges
    const isSafe = await this.urlGuard(url);
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
    const httpResultsArePoor = !isBotChallenge && this.needsHeadlessVerification(result, detectedPlatform);

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
      await this.extractPageData(page, result);

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
    } catch {
      console.log("⚠️ Dynamic content wait timeout, continuing with scan...");
    }
  }

  private async extractPageData(
    page: Page,
    result: ScanResult,
  ): Promise<void> {
    // Parse the RENDERED DOM with the same parser the HTTP path uses, then map
    // through the one shared mapping (parse-html.applyParsedHtml) so both routes
    // populate identical parser fields and can't drift (PC-08). page.content()
    // is the hydrated HTML after waitForDynamicContent, so client-injected
    // content, links and JSON-LD are included. result already has url + status.
    applyParsedHtml(result, extractFromHtml(await page.content(), result.url));

    // Network step (not pure): probe image file sizes. Images are blocked during
    // the render, so they are HEADed separately — same as the HTTP path.
    await this.fetchImageFileSizes(result.images);

    // LCP candidate: largest visible image or hero text. Needs rendered layout
    // (natural image size, element box), so it can only be derived here — the
    // HTML parser can't compute it.
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

    // Mark as headless scan
    result.scan_method = "headless";
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

  private needsHeadlessVerification(
    result: ScanResult,
    platform?: string | null,
  ): boolean {
    return needsHeadlessEscalation(result, platform ?? null);
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
        const redirectHops: { from: string; status: number; to: string }[] = [];
        let currentUrl = url;
        let response: Response | null = null;
        const maxRedirects = 10;

        const fetchStart = Date.now();

        const seenUrls = new Set<string>();
        let loopDetected = false;

        for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
          // Key on a normalised form so a slash/scheme-variant cycle
          // (A → A/ → A …) is caught as a loop, not run to the hop budget (R-04).
          const seenKey = normalizeForSelfCompare(currentUrl) ?? currentUrl;
          if (seenUrls.has(seenKey)) {
            // Redirect loop detected — record it and break
            result.redirect_chain = [...redirectChain, currentUrl];
            loopDetected = true;
            break;
          }
          seenUrls.add(seenKey);

          response = await this.fetchImpl(currentUrl, {
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
              let nextUrl: string;
              try {
                nextUrl = new URL(location, currentUrl).href;
              } catch {
                nextUrl = location;
              }
              // Record this hop's status so 301/308 (permanent) can be told
              // apart from 302/303/307 (temporary) later (R-01).
              redirectHops.push({ from: currentUrl, status: response.status, to: nextUrl });
              currentUrl = nextUrl;
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

        // Still a 3xx after the loop (and not a detected loop): either the hop
        // budget was exhausted or a redirect had no Location. Flag it rather
        // than silently storing a bare redirect as if it were the page (R-03/S-03).
        if (!loopDetected && response.status >= 300 && response.status < 400) {
          result.redirect_limit_hit = true;
        }

        // Store the redirect chain (only if there were redirects)
        if (redirectChain.length > 0) {
          result.redirect_chain = redirectChain;
        }
        if (redirectHops.length > 0) {
          result.redirect_hops = redirectHops;
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

        // Non-HTML resource (PDF, image, feed, JSON …): record it for
        // broken-link/redirect tracking but don't parse it or score it as a
        // page (S-02). XHTML is HTML and still parsed (E-03).
        if (!isHtmlContentType(result.content_type)) {
          clearTimeout(timeoutId);
          result.is_non_html = true;
          result.load_time_ms = Date.now() - fetchStart;
          return result;
        }

        // Read the raw bytes and decode with the page's declared charset (P-07).
        // response.text() assumes UTF-8, mangling windows-1252 / Shift_JIS pages.
        // Parsing is capped at MAX_HTML_BYTES so a pathological page can't
        // exhaust memory (E-02).
        const bodyBuf = new Uint8Array(await response.arrayBuffer());
        const html = decodeHtmlBody(bodyBuf, result.content_type, MAX_HTML_BYTES);
        clearTimeout(timeoutId);
        // Real load time: first byte through full body download. Everything
        // after this (HTML parsing, image HEADs, readability) is our analysis
        // and must not count toward the page's load time.
        result.load_time_ms = Date.now() - fetchStart;
        // Page weight = bytes actually transferred (E-04). Prefer the
        // Content-Length header (the compressed download size the user pays
        // for); fall back to the decompressed body length when it's absent
        // (chunked responses). This is a real transfer measure, unlike the
        // headless path's serialized rendered-DOM length — so the
        // large_page_size check is HTTP-only (PF-03).
        const contentLengthHeader = Number(response.headers.get("content-length"));
        result.size_bytes =
          Number.isFinite(contentLengthHeader) && contentLengthHeader > 0
            ? contentLengthHeader
            : bodyBuf.byteLength;
        if (bodyBuf.byteLength > MAX_HTML_BYTES) {
          (result.warnings ??= []).push(
            `HTML body ${(bodyBuf.byteLength / 1048576).toFixed(1)} MB exceeds the ${MAX_HTML_BYTES / 1048576} MB parse cap; analysed the first ${MAX_HTML_BYTES / 1048576} MB`,
          );
        }

        await this.processHtml(result, html);

        // Canonical declared in the HTTP `Link` header (CN-05). Merge it with
        // any HTML <link rel=canonical>: a header canonical and a differing HTML
        // one are conflicting signals, surfaced via canonical_urls (CN-01).
        const headerCanonical = parseLinkHeaderCanonical(
          response.headers.get("link"),
          result.url,
        );
        if (headerCanonical) {
          const set = new Set(result.canonical_urls ?? []);
          if (result.canonical_url) set.add(result.canonical_url);
          set.add(headerCanonical);
          result.canonical_urls = [...set];
          if (!result.canonical_url) {
            result.canonical_url = headerCanonical;
            result.canonical_is_self = isSelfCanonical(headerCanonical, result.url);
          }
        }

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
  ): Promise<void> {
    // Parse the fetched HTML and map every parser field onto the result through
    // the one shared mapping (parse-html.applyParsedHtml), so the HTTP and
    // headless routes can't drift on which fields they populate (PC-08). result
    // already has url, status and any X-Robots-Tag header flags set.
    applyParsedHtml(result, extractFromHtml(html, result.url));

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
   * Fetch file sizes for images via HEAD requests (limited to first N images).
   */
  private async fetchImageFileSizes(
    images: ScanResult["images"],
    limit: number = 20,
  ): Promise<void> {
    // Images beyond the probe cap are size-unknown, not "fine" (L-04).
    for (const img of images.slice(limit)) img.file_size_unknown = true;

    const toCheck = images.slice(0, limit);
    const promises = toCheck.map(async (img) => {
      try {
        // SSRF guard: img.src comes from the scanned page, so it could point at
        // a private/internal host. Only HEAD public URLs (same guard the primary
        // fetch uses).
        if (!(await this.urlGuard(img.src))) {
          img.file_size_unknown = true;
          return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await this.fetchImpl(img.src, {
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
        } else {
          // 200 with no Content-Length (chunked/streamed) — size still unknown.
          img.file_size_unknown = true;
        }
      } catch {
        // HEAD failed — file size unknown, not confirmed small.
        img.file_size_unknown = true;
      }
    });
    await Promise.allSettled(promises);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
