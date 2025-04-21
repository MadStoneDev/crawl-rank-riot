import puppeteer from "puppeteer";
import { BaseScanner, ScannerOptions } from "./base";
import { ScanResult } from "../../../types/common";
import { UrlProcessor } from "../utils/url";

/**
 * Options for the headless browser scanner
 */
export interface HeadlessBrowserOptions extends ScannerOptions {
  viewport?: { width: number; height: number };
}

/**
 * Headless browser scanner that uses Puppeteer for JavaScript rendering
 */
export class HeadlessBrowser extends BaseScanner {
  private viewport: { width: number; height: number };

  /**
   * Creates a new headless browser scanner
   * @param options Scanner options
   */
  constructor(options: HeadlessBrowserOptions = {}) {
    super(options);
    this.viewport = options.viewport || { width: 1280, height: 800 };
  }

  /**
   * Scan a URL using a headless browser
   * @param url URL to scan
   * @param depth Current crawl depth
   * @returns Scan result
   */
  async scan(url: string, depth: number): Promise<ScanResult> {
    const startTime = Date.now();
    const result = this.createBaseScanResult(url, depth);
    result.scan_method = "headless";

    // Initialize arrays that might be undefined
    result.warnings = result.warnings || [];
    result.errors = result.errors || [];

    let browser;

    try {
      // Launch browser
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage();

      // Set user agent and viewport
      await page.setUserAgent(this.userAgent);
      await page.setViewport(this.viewport);

      // Track redirects
      let initialUrl = url;
      page.on("response", (response) => {
        const status = response.status();
        if (status >= 300 && status < 400) {
          result.is_redirect = true;
        }
      });

      // Set request timeout
      await page.setDefaultNavigationTimeout(this.timeout);

      // Navigate to URL
      const response = await page.goto(url, {
        waitUntil: "networkidle2", // Wait until network is idle (helpful for SPAs)
      });

      // Create URL processor for handling URLs
      const urlProcessor = new UrlProcessor(url);

      // Record resulting URL (in case of redirect)
      const finalUrl = page.url();
      if (initialUrl !== finalUrl) {
        result.redirected_from = initialUrl;
        result.url = urlProcessor.normalize(finalUrl);
      }

      // Record HTTP status
      result.status = response ? response.status() : 0;

      // Get content type
      const contentType = response ? response.headers()["content-type"] : null;
      result.content_type = contentType || "";

      // Extract page metadata
      result.title = await page.title();

      // Get meta description
      result.meta_description = await page.evaluate(() => {
        const metaDesc = document.querySelector('meta[name="description"]');
        return metaDesc ? metaDesc.getAttribute("content") || "" : "";
      });

      // Extract headings
      result.h1s = await this.extractHeadings(page, "h1");
      result.h2s = await this.extractHeadings(page, "h2");
      result.h3s = await this.extractHeadings(page, "h3");
      result.h4s = await this.extractHeadings(page, "h4");
      result.h5s = await this.extractHeadings(page, "h5");
      result.h6s = await this.extractHeadings(page, "h6");

      // Extract robots meta directives
      const robotsMeta = await page.evaluate(() => {
        const metaRobots = document.querySelector('meta[name="robots"]');
        return metaRobots ? metaRobots.getAttribute("content") || "" : "";
      });

      result.has_robots_noindex = robotsMeta.toLowerCase().includes("noindex");
      result.has_robots_nofollow = robotsMeta
        .toLowerCase()
        .includes("nofollow");
      result.is_indexable = !result.has_robots_noindex;

      // Wait for any delayed JavaScript to potentially execute and alter the DOM
      // Replace waitForTimeout with setTimeout wrapped in a promise
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Simulate user actions to trigger potential dynamic content
      await this.simulateUserActions(page);

      // Extract content for analysis
      const content = await page.evaluate(() => {
        // Remove script and style elements
        const scripts = document.querySelectorAll("script, style");
        scripts.forEach((s) => s.remove());

        // Get text content
        return document.body.textContent || "";
      });

      // Calculate content metrics
      result.content_length = content.length;
      result.word_count = content
        .split(/\s+/)
        .filter((w) => w.length > 0).length;

      // Extract links
      await this.extractLinks(page, result, urlProcessor);

      // Extract images
      await this.extractImages(page, result, urlProcessor);

      // Look for client-side routing libraries
      const routingLibraries = await this.detectClientSideRouting(page);
      if (routingLibraries.length > 0) {
        result.warnings.push(
          `Detected potential client-side routing: ${routingLibraries.join(
            ", ",
          )}`,
        );
      }

      // Extract paths from client-side routes if detected
      if (routingLibraries.length > 0) {
        const routePaths = await this.extractClientSideRoutes(page);

        // Add detected route paths as internal links
        for (const path of routePaths) {
          try {
            const fullUrl = urlProcessor.resolve(result.url, path);
            if (!fullUrl) continue;

            // Check if we already have this URL
            const exists = result.internal_links.some(
              (link) => link.url === fullUrl,
            );

            if (!exists) {
              result.internal_links.push({
                url: fullUrl,
                anchor_text: `[Route: ${path}]`,
                rel_attributes: [],
              });
            }
          } catch (error) {
            // Skip invalid URLs
          }
        }
      }

      // Extract structured data
      await this.extractStructuredData(page, result);

      // Count scripts and styles
      result.js_count = await page.$$eval(
        "script[src]",
        (scripts) => scripts.length,
      );
      result.css_count = await page.$$eval(
        'link[rel="stylesheet"]',
        (links) => links.length,
      );
    } catch (error: any) {
      console.error(`Error in headless scan for ${url}:`, error);
      result.status = 0;
      result.errors.push(`Headless browser error: ${error.message}`);
    } finally {
      // Close browser
      if (browser) {
        await browser.close();
      }
    }

    result.load_time_ms = Date.now() - startTime;
    return result;
  }

  /**
   * Extract headings from the page
   * @param page Puppeteer page
   * @param selector Heading selector (h1, h2, etc.)
   * @returns Array of heading text
   */
  private async extractHeadings(
    page: any,
    selector: string,
  ): Promise<string[]> {
    return page.$$eval(selector, (headings: any[]) =>
      headings.map((h) => h.textContent?.trim() || ""),
    );
  }

  /**
   * Extract links from the page
   * @param page Puppeteer page
   * @param result Scan result to update
   * @param urlProcessor URL processor
   */
  private async extractLinks(
    page: any,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    const domain = urlProcessor.getDomain();

    // Initialize arrays if not defined
    result.internal_links = result.internal_links || [];
    result.external_links = result.external_links || [];

    // Extract links
    const links = await page.evaluate((domain: string) => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((a) => {
          const href = a.getAttribute("href");
          if (!href || href === "#" || href.startsWith("javascript:")) {
            return null;
          }

          const relAttr = a.getAttribute("rel") || "";
          const relAttributes = relAttr.split(/\s+/).filter(Boolean);

          try {
            return {
              href,
              text: a.textContent?.trim() || "",
              rel: relAttributes,
              // Let the URL processor handle the actual check later
              isInternal: true,
            };
          } catch (e) {
            return null;
          }
        })
        .filter((link) => link !== null);
    }, domain);

    // Process links
    for (const link of links) {
      try {
        const resolvedUrl = urlProcessor.resolve(result.url, link.href);
        if (!resolvedUrl) continue;

        const isInternal = urlProcessor.isInternal(resolvedUrl);

        if (isInternal) {
          result.internal_links.push({
            url: resolvedUrl,
            anchor_text: link.text,
            rel_attributes: link.rel,
          });
        } else {
          result.external_links.push({
            url: resolvedUrl,
            anchor_text: link.text,
            rel_attributes: link.rel,
          });
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  /**
   * Extract images from the page
   * @param page Puppeteer page
   * @param result Scan result to update
   * @param urlProcessor URL processor
   */
  private async extractImages(
    page: any,
    result: ScanResult,
    urlProcessor: UrlProcessor,
  ): Promise<void> {
    // Initialize images array if not defined
    result.images = result.images || [];

    const images = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .map((img) => {
          const src = img.getAttribute("src");
          if (!src) return null;

          return {
            src,
            alt: img.getAttribute("alt") || "",
            width: img.width,
            height: img.height,
          };
        })
        .filter((img) => img !== null);
    });

    for (const img of images) {
      try {
        const resolvedUrl = urlProcessor.resolve(result.url, img.src);
        if (!resolvedUrl) continue;

        result.images.push({
          src: resolvedUrl,
          alt: img.alt,
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }
  }

  /**
   * Extract structured data from the page
   * @param page Puppeteer page
   * @param result Scan result to update
   */
  private async extractStructuredData(
    page: any,
    result: ScanResult,
  ): Promise<void> {
    // Initialize structured_data and schema_types arrays if not defined
    result.structured_data = result.structured_data || [];
    result.schema_types = result.schema_types || [];

    result.structured_data = await page.evaluate(() => {
      const data = [];

      // Look for JSON-LD
      const scripts = document.querySelectorAll(
        'script[type="application/ld+json"]',
      );

      for (const script of Array.from(scripts)) {
        try {
          const content = script.textContent;
          if (content) {
            const parsed = JSON.parse(content);
            data.push(parsed);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }

      return data;
    });

    // Extract schema types
    result.schema_types = result.structured_data.flatMap((data) => {
      if (data["@type"]) {
        return Array.isArray(data["@type"]) ? data["@type"] : [data["@type"]];
      }
      return [];
    });
  }

  /**
   * Simulate user actions to potentially reveal hidden content
   * @param page Puppeteer page
   */
  private async simulateUserActions(page: any): Promise<void> {
    try {
      // Scroll down to load lazy content
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Click on elements that might reveal menus
      await page.evaluate(() => {
        // Common menu trigger selectors
        const menuSelectors = [
          ".menu-toggle",
          ".navbar-toggle",
          ".hamburger",
          ".menu-button",
          'button[aria-label="Menu"]',
          'button[aria-label="Navigation"]',
          ".nav-toggle",
          "#menu-button",
          '[data-toggle="dropdown"]',
          ".dropdown-toggle",
        ];

        for (const selector of menuSelectors) {
          const elements = document.querySelectorAll(selector);
          for (const el of Array.from(elements)) {
            // Only click visible elements
            if ((el as HTMLElement).offsetParent !== null) {
              (el as HTMLElement).click();
            }
          }
        }
      });

      // Wait for any animations to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error("Error during user action simulation:", error);
    }
  }

  /**
   * Detect client-side routing libraries
   * @param page Puppeteer page
   * @returns Array of detected libraries
   */
  private async detectClientSideRouting(page: any): Promise<string[]> {
    try {
      return await page.evaluate(() => {
        const libraries: string[] = [];

        // Check for React Router
        if (
          "React" in window ||
          document.querySelector("[data-reactroot]") ||
          document.querySelector("[data-reactid]")
        ) {
          if (
            "__INITIAL_STATE__" in window ||
            document.querySelector("#root")
          ) {
            libraries.push("React");
          }
        }

        // Check for Vue Router
        if ("Vue" in window || document.querySelector("[data-v-]")) {
          libraries.push("Vue.js");
        }

        // Check for Angular
        if (
          document.querySelector("[ng-app]") ||
          document.querySelector("[ng-controller]")
        ) {
          libraries.push("Angular");
        }

        // Check for Next.js
        if (
          document.querySelector("#__next") ||
          document.querySelector("[data-next-page]")
        ) {
          libraries.push("Next.js");
        }

        return libraries;
      });
    } catch (error) {
      console.error("Error detecting client-side routing:", error);
      return [];
    }
  }

  /**
   * Extract client-side routes from JavaScript frameworks
   * @param page Puppeteer page
   * @returns Array of detected route paths
   */
  private async extractClientSideRoutes(page: any): Promise<string[]> {
    try {
      return await page.evaluate(() => {
        const paths = new Set<string>();

        // Helper to sanitize and validate paths
        const addPath = (path: string) => {
          // Skip empty paths or obvious non-routes
          if (!path || path === "/" || path.includes("*")) return;

          // Skip paths with special characters that are unlikely to be routes
          if (/[<>{}|\^~`]/.test(path)) return;

          // Use only the path part if it's a full URL
          try {
            const url = new URL(path);
            paths.add(url.pathname);
          } catch {
            // Not a URL, treat as path
            if (path.startsWith("/")) {
              paths.add(path);
            }
          }
        };

        // Extract from script tags
        const scripts = document.querySelectorAll("script:not([src])");
        for (const script of Array.from(scripts)) {
          const content = script.textContent || "";

          // Look for route definitions
          const routePatterns = [
            /path:\s*["'](\/[^"']+)["']/g, // Common in React Router, Vue Router
            /route:\s*["'](\/[^"']+)["']/g, // Alternative syntax
            /["'](\/[a-zA-Z0-9_-]+)["']/g, // General path pattern
          ];

          for (const pattern of routePatterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
              if (match[1]) {
                addPath(match[1]);
              }
            }
          }
        }

        return Array.from(paths);
      });
    } catch (error) {
      console.error("Error extracting client-side routes:", error);
      return [];
    }
  }
}
