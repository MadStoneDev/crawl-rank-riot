import { ScanResult } from "../types";

/**
 * Broken Link and Asset Analyzer
 * Detects broken links, images, and other assets
 */

export interface BrokenAsset {
  type: "internal_link" | "external_link" | "image" | "css" | "js" | "other";
  url: string;
  foundOn: string; // Which page(s) have the broken link
  httpStatus: number | null;
  errorType:
    | "not_found"
    | "timeout"
    | "server_error"
    | "ssl_error"
    | "dns_error";
  message: string;
}

export interface BrokenAssetReport {
  totalBroken: number;
  brokenByType: {
    internal_links: number;
    external_links: number;
    images: number;
    css: number;
    js: number;
    other: number;
  };
  assets: BrokenAsset[];
  criticalPages: string[]; // Pages with most broken assets
  score: number; // 0-100, penalty for broken assets
}

export class BrokenAssetAnalyzer {
  private scanResults: ScanResult[];
  private brokenAssets: Map<string, BrokenAsset> = new Map();

  constructor(scanResults: ScanResult[]) {
    this.scanResults = scanResults;
  }

  /**
   * Analyze all assets for broken links
   */
  async analyze(): Promise<BrokenAssetReport> {
    console.log("🔍 Analyzing broken links and assets...");

    // Step 1: Check internal links
    await this.checkInternalLinks();

    // Step 2: Sample external links (don't check all - can be slow)
    await this.checkExternalLinks(20); // Check up to 20 external links

    // Step 3: Check images
    await this.checkImages();

    // Step 4: Check CSS/JS files
    await this.checkAssets();

    // Generate report
    return this.generateReport();
  }

  /**
   * Check internal links - these are in our scan results
   */
  private async checkInternalLinks(): Promise<void> {
    console.log("🔗 Checking internal links...");

    // Build a set of all URLs we successfully scanned
    const scannedUrls = new Set(
      this.scanResults
        .filter((r) => r.status >= 200 && r.status < 400)
        .map((r) => r.url),
    );

    // Check all internal links found during scan
    for (const result of this.scanResults) {
      for (const link of result.internal_links) {
        const normalizedUrl = this.normalizeUrl(link.url);

        // If link not in our successfully scanned URLs, it might be broken
        if (!scannedUrls.has(normalizedUrl)) {
          // Try to determine status
          const status = this.getUrlStatus(normalizedUrl);

          if (!status || status >= 400) {
            this.addBrokenAsset({
              type: "internal_link",
              url: normalizedUrl,
              foundOn: result.url,
              httpStatus: status,
              errorType: this.classifyError(status),
              message: `Broken internal link: ${
                link.anchor_text || "no anchor"
              }`,
            });
          }
        }
      }
    }
  }

  /**
   * Check a sample of external links
   */
  private async checkExternalLinks(maxToCheck: number = 20): Promise<void> {
    console.log(`🌐 Checking external links (sampling ${maxToCheck})...`);

    // Collect unique external links
    const externalLinks = new Map<string, string[]>(); // url -> [pages where found]

    for (const result of this.scanResults) {
      for (const link of result.external_links) {
        const url = link.url;
        if (!externalLinks.has(url)) {
          externalLinks.set(url, []);
        }
        externalLinks.get(url)!.push(result.url);
      }
    }

    // Sort by frequency (most common first) and take sample
    const sortedLinks = Array.from(externalLinks.entries()).sort(
      (a, b) => b[1].length - a[1].length,
    );

    const linksToCheck = sortedLinks.slice(0, maxToCheck);

    // Check each link
    for (const [url, foundOnPages] of linksToCheck) {
      try {
        const status = await this.checkUrlStatus(url, 5000); // 5s timeout

        if (!status || status >= 400) {
          this.addBrokenAsset({
            type: "external_link",
            url,
            foundOn: foundOnPages[0], // Report first occurrence
            httpStatus: status,
            errorType: this.classifyError(status),
            message: `Broken external link (found on ${foundOnPages.length} page(s))`,
          });
        }
      } catch (error) {
        this.addBrokenAsset({
          type: "external_link",
          url,
          foundOn: foundOnPages[0],
          httpStatus: null,
          errorType: "timeout",
          message: `External link timeout or network error`,
        });
      }

      // Small delay to avoid overwhelming servers
      await this.delay(200);
    }
  }

  /**
   * Check images for 404s
   */
  private async checkImages(): Promise<void> {
    console.log("🖼️ Checking images...");

    // Collect all unique image URLs
    const imageUrls = new Map<string, string[]>(); // image url -> [pages where found]

    for (const result of this.scanResults) {
      if (result.images && result.images.length > 0) {
        for (const image of result.images) {
          const imgUrl = this.resolveUrl(image.src, result.url);
          if (!imgUrl) continue;

          if (!imageUrls.has(imgUrl)) {
            imageUrls.set(imgUrl, []);
          }
          imageUrls.get(imgUrl)!.push(result.url);
        }
      }
    }

    console.log(`   Found ${imageUrls.size} unique images to check`);

    // Check each image (sample if too many)
    const imagesToCheck = Array.from(imageUrls.entries()).slice(0, 50); // Limit to 50

    for (const [imgUrl, foundOnPages] of imagesToCheck) {
      try {
        const status = await this.checkUrlStatus(imgUrl, 3000, true); // HEAD request

        if (!status || status >= 400) {
          this.addBrokenAsset({
            type: "image",
            url: imgUrl,
            foundOn: foundOnPages[0],
            httpStatus: status,
            errorType: this.classifyError(status),
            message: `Broken image (found on ${foundOnPages.length} page(s))`,
          });
        }
      } catch (error) {
        // Silently skip images that time out (might be lazy-loaded, etc.)
      }

      await this.delay(100);
    }
  }

  /**
   * Check CSS and JS files
   */
  private async checkAssets(): Promise<void> {
    console.log("📦 Checking CSS/JS assets...");

    // Extract asset URLs from scan results
    const assets = new Map<string, { type: "css" | "js"; foundOn: string[] }>();

    for (const result of this.scanResults) {
      const content = JSON.stringify(result);

      // Extract CSS links
      const cssMatches = content.match(
        /<link[^>]*rel=["']stylesheet["'][^>]*>/gi,
      );
      if (cssMatches) {
        for (const match of cssMatches) {
          const hrefMatch = match.match(/href=["']([^"']+)["']/i);
          if (hrefMatch) {
            const cssUrl = this.resolveUrl(hrefMatch[1], result.url);
            if (cssUrl) {
              if (!assets.has(cssUrl)) {
                assets.set(cssUrl, { type: "css", foundOn: [] });
              }
              assets.get(cssUrl)!.foundOn.push(result.url);
            }
          }
        }
      }

      // Extract JS scripts
      const jsMatches = content.match(/<script[^>]*src=["']([^"']+)["']/gi);
      if (jsMatches) {
        for (const match of jsMatches) {
          const srcMatch = match.match(/src=["']([^"']+)["']/i);
          if (srcMatch) {
            const jsUrl = this.resolveUrl(srcMatch[1], result.url);
            if (
              jsUrl &&
              !jsUrl.includes("gtag") &&
              !jsUrl.includes("analytics")
            ) {
              // Skip tracking scripts
              if (!assets.has(jsUrl)) {
                assets.set(jsUrl, { type: "js", foundOn: [] });
              }
              assets.get(jsUrl)!.foundOn.push(result.url);
            }
          }
        }
      }
    }

    console.log(`   Found ${assets.size} CSS/JS assets to check`);

    // Check each asset
    const assetsToCheck = Array.from(assets.entries()).slice(0, 30); // Limit to 30

    for (const [assetUrl, info] of assetsToCheck) {
      try {
        const status = await this.checkUrlStatus(assetUrl, 3000, true);

        if (!status || status >= 400) {
          this.addBrokenAsset({
            type: info.type,
            url: assetUrl,
            foundOn: info.foundOn[0],
            httpStatus: status,
            errorType: this.classifyError(status),
            message: `Broken ${info.type.toUpperCase()} file (found on ${
              info.foundOn.length
            } page(s))`,
          });
        }
      } catch (error) {
        // Skip timeouts on assets
      }

      await this.delay(100);
    }
  }

  /**
   * Check URL status with actual HTTP request
   */
  private async checkUrlStatus(
    url: string,
    timeout: number = 5000,
    useHead: boolean = false,
  ): Promise<number | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method: useHead ? "HEAD" : "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "RankRiot/1.0 SEO Crawler",
        },
      });

      clearTimeout(timeoutId);
      return response.status;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get URL status from scan results (if available)
   */
  private getUrlStatus(url: string): number | null {
    const result = this.scanResults.find((r) => r.url === url);
    return result ? result.status : null;
  }

  /**
   * Add broken asset to collection (avoid duplicates)
   */
  private addBrokenAsset(asset: BrokenAsset): void {
    const key = `${asset.type}-${asset.url}`;
    if (!this.brokenAssets.has(key)) {
      this.brokenAssets.set(key, asset);
      console.log(`   ❌ Found broken ${asset.type}: ${asset.url}`);
    }
  }

  /**
   * Classify error type based on HTTP status
   */
  private classifyError(status: number | null): BrokenAsset["errorType"] {
    if (status === null) return "timeout";
    if (status === 404) return "not_found";
    if (status >= 500) return "server_error";
    if (status === 526 || status === 525) return "ssl_error";
    return "not_found";
  }

  /**
   * Generate comprehensive report
   */
  private generateReport(): BrokenAssetReport {
    const assets = Array.from(this.brokenAssets.values());

    const brokenByType = {
      internal_links: assets.filter((a) => a.type === "internal_link").length,
      external_links: assets.filter((a) => a.type === "external_link").length,
      images: assets.filter((a) => a.type === "image").length,
      css: assets.filter((a) => a.type === "css").length,
      js: assets.filter((a) => a.type === "js").length,
      other: assets.filter(
        (a) =>
          !["internal_link", "external_link", "image", "css", "js"].includes(
            a.type,
          ),
      ).length,
    };

    // Find pages with most broken assets
    const pageBreakCounts = new Map<string, number>();
    for (const asset of assets) {
      const count = pageBreakCounts.get(asset.foundOn) || 0;
      pageBreakCounts.set(asset.foundOn, count + 1);
    }

    const criticalPages = Array.from(pageBreakCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([page]) => page);

    // Calculate score (penalty for broken assets)
    let score = 100;
    score -= Math.min(brokenByType.internal_links * 5, 40); // -5 per broken internal link
    score -= Math.min(brokenByType.images * 2, 20); // -2 per broken image
    score -= Math.min(brokenByType.css * 10, 30); // -10 per broken CSS (severe)
    score -= Math.min(brokenByType.js * 10, 30); // -10 per broken JS (severe)
    score -= Math.min(brokenByType.external_links * 1, 10); // -1 per broken external link

    return {
      totalBroken: assets.length,
      brokenByType,
      assets,
      criticalPages,
      score: Math.max(0, score),
    };
  }

  /**
   * Normalize URL for comparison
   */
  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.href.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  /**
   * Resolve relative URL against base
   */
  private resolveUrl(url: string, baseUrl: string): string | null {
    try {
      return new URL(url, baseUrl).href;
    } catch {
      return null;
    }
  }

  /**
   * Simple delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
