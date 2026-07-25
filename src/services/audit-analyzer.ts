import {
  ScanResult,
  AuditAnalysis,
  AuditRecommendation,
  TechStackAnalysis,
  DesignAnalysis,
  PerformanceAnalysis,
  CompletenessAnalysis,
  ModernStandardsAnalysis,
  ModernizationAnalysis,
} from "../types";
import { proxyFetch } from "../utils/proxy";
import { USER_AGENT } from "../config/identity";

export class AuditAnalyzer {
  private scanResults: ScanResult[];
  private baseUrl: string;
  private customPagePaths: Record<string, string>;

  constructor(
    scanResults: ScanResult[],
    baseUrl: string,
    customPagePaths: Record<string, string> = {},
  ) {
    this.scanResults = scanResults;
    this.baseUrl = baseUrl;
    this.customPagePaths = customPagePaths;
  }

  /**
   * Main analysis method - runs all analyzers
   */
  async analyze(): Promise<{
    analysis: AuditAnalysis;
    recommendations: AuditRecommendation[];
    overallScore: number;
  }> {
    console.log(`🔍 Starting audit analysis for ${this.baseUrl}...`);

    const modernization = await this.analyzeModernization();
    const performance = await this.analyzePerformance();
    const completeness = await this.analyzeCompleteness();
    const techStack = await this.analyzeTechStack();
    const design = await this.analyzeDesign();
    const modernStandards = await this.analyzeModernStandards();

    const analysis: AuditAnalysis = {
      modernization,
      performance,
      completeness,
      techStack,
      design,
      modernStandards,
    };

    // Content-sufficiency guard (the audit analog of "no data = 0"). Each
    // category scores 100-minus-penalties, so a crawl that returned almost
    // nothing triggers few penalties and would score high — e.g. performance
    // sees no pages, reports "Good load time (0s)" and stays at 100. If the
    // crawl did not gather enough real content to assess the site, force every
    // category and the overall to 0 rather than publish a flattering number.
    const recommendations = this.generateRecommendations(analysis);
    let overallScore: number;
    if (!this.hasSufficientContent()) {
      const note = "Not scored: the crawl did not return enough content to assess this site.";
      modernization.score = 0;
      performance.score = 0;
      completeness.score = 0; // CompletenessAnalysis has no findings array
      design.score = 0;
      modernStandards.score = 0;
      for (const category of [modernization, performance, design, modernStandards]) {
        category.findings = [note, ...category.findings];
      }
      overallScore = 0;
      console.log("⚠️ Audit not scored — insufficient content crawled.");
    } else {
      overallScore = this.calculateOverallScore(analysis);
    }

    console.log(
      `✅ Audit analysis complete. Overall score: ${overallScore}/100`,
    );

    return {
      analysis,
      recommendations,
      overallScore,
    };
  }

  /**
   * Whether the crawl gathered enough real content to legitimately score the
   * site. Requires at least one reachable (2xx) page with actual content — a
   * title or a non-trivial word count. A blocked/blanked/empty crawl fails this
   * and must not produce a flattering "100 minus penalties" score.
   */
  private hasSufficientContent(): boolean {
    return this.scanResults.some(
      (r) =>
        r.status >= 200 &&
        r.status < 300 &&
        ((r.word_count || 0) >= 50 || !!(r.title && r.title.trim().length > 0)),
    );
  }

  /**
   * Analyze tech stack - IMPROVED VERSION
   */
  private async analyzeTechStack(): Promise<TechStackAnalysis> {
    console.log("🔧 Analyzing tech stack...");

    const findings: string[] = [];
    const libraries: string[] = [];
    const analytics: string[] = [];

    let framework: string | undefined;
    let cms: string | undefined;
    let hasWordPress = false;
    let hasShopify = false;
    let hasReact = false;
    let hasVue = false;
    let hasNextJs = false;

    // Detection confidence scores
    let nextJsConfidence = 0;
    let reactConfidence = 0;
    let shopifyConfidence = 0;

    // Analyze first few pages for tech detection
    const samplesToCheck = this.scanResults.slice(0, 10);

    for (const result of samplesToCheck) {
      const scripts = this.extractScripts(result);
      const linkTags = this.extractLinkTags(result);
      const urlLower = result.url.toLowerCase();
      const allSrcPaths = [...scripts, ...linkTags].map((s) => s.toLowerCase());
      const metaContent = JSON.stringify(result.open_graph || {}).toLowerCase() +
        JSON.stringify(result.twitter_card || {}).toLowerCase();

      // Next.js detection (high priority) — check script/link paths only
      if (allSrcPaths.some((s) => s.includes("_next/static") || s.includes("/__next"))) {
        nextJsConfidence += 10;
      }
      if (scripts.some((s) => s.includes("_next/") || s.includes("next-"))) {
        nextJsConfidence += 10;
      }

      // React detection — check script paths only
      if (scripts.some((s) => s.toLowerCase().includes("react"))) {
        reactConfidence += 10;
      }

      // Shopify detection — check script/link src, URL, and meta tags only
      if (allSrcPaths.some((s) => s.includes("cdn.shopify.com"))) {
        shopifyConfidence += 10;
      }
      if (urlLower.includes("myshopify.com")) {
        shopifyConfidence += 10;
      }
      if (metaContent.includes("shopify")) {
        shopifyConfidence += 3;
      }

      // Strongest signal: the platform the scanner already detected from
      // response headers + HTML (covers Shopify on custom domains, which the
      // anchor-link heuristics above miss because asset URLs aren't captured).
      const platform = (result.detected_platform || "").toLowerCase();
      if (platform === "shopify") {
        shopifyConfidence += 10;
      } else if (platform === "wordpress") {
        hasWordPress = true;
        cms = "WordPress";
      } else if (
        platform &&
        !cms &&
        ["squarespace", "wix", "webflow", "ghost", "drupal", "joomla", "bigcommerce"].includes(platform)
      ) {
        cms = platform.charAt(0).toUpperCase() + platform.slice(1);
      }

      // Detect CMS (WordPress) — check script/link paths only
      if (allSrcPaths.some((s) => s.includes("wp-content") || s.includes("wp-includes"))) {
        hasWordPress = true;
        cms = "WordPress";
      }

      // Detect Vue — check script paths only
      if (scripts.some((s) => s.toLowerCase().includes("vue"))) {
        hasVue = true;
      }

      // Detect libraries — check script paths only
      if (scripts.some((s) => s.toLowerCase().includes("jquery")) && !libraries.includes("jQuery")) {
        libraries.push("jQuery");
      }
      if (allSrcPaths.some((s) => s.includes("bootstrap")) && !libraries.includes("Bootstrap")) {
        libraries.push("Bootstrap");
      }
      if (allSrcPaths.some((s) => s.includes("tailwind")) && !libraries.includes("Tailwind CSS")) {
        libraries.push("Tailwind CSS");
      }

      // Detect analytics — check script paths only
      if (scripts.some((s) => s.toLowerCase().includes("google-analytics") || s.toLowerCase().includes("gtag"))) {
        if (!analytics.includes("Google Analytics")) {
          analytics.push("Google Analytics");
        }
      }
      if (scripts.some((s) => s.toLowerCase().includes("gtm") || s.toLowerCase().includes("googletagmanager"))) {
        if (!analytics.includes("Google Tag Manager")) {
          analytics.push("Google Tag Manager");
        }
      }
    }

    // Determine framework based on confidence (prioritize modern frameworks)
    if (nextJsConfidence >= 10) {
      hasNextJs = true;
      hasReact = true;
      framework = "Next.js";
    } else if (reactConfidence >= 10) {
      hasReact = true;
      framework = "React";
    } else if (hasVue) {
      framework = "Vue.js";
    }

    // Shopify is a CMS/platform and can coexist with a JS framework (e.g.
    // Hydrogen), so set it whenever confidence is high — don't suppress it just
    // because a framework was also detected.
    if (shopifyConfidence >= 10) {
      hasShopify = true;
      cms = "Shopify";
    }

    // Generate findings
    if (framework) {
      findings.push(`Modern framework detected: ${framework}`);
    }
    if (cms) {
      findings.push(`CMS detected: ${cms}`);
    }
    if (libraries.length > 0) {
      findings.push(`Libraries: ${libraries.join(", ")}`);
    }
    if (analytics.length === 0) {
      findings.push("No analytics detected");
    } else {
      findings.push(`Analytics: ${analytics.join(", ")}`);
    }

    return {
      framework,
      cms,
      libraries,
      hasWordPress,
      hasShopify,
      hasReact,
      hasVue,
      hasNextJs,
      analytics,
      findings,
    };
  }

  /**
   * Analyze site completeness - IMPROVED VERSION
   */
  private async analyzeCompleteness(): Promise<CompletenessAnalysis> {
    console.log("📋 Analyzing completeness...");

    let score = 100;
    const siteType = this.detectSiteType();
    const expectedPages = this.getExpectedPages(siteType);
    const foundPages: string[] = [];
    const missingPages: string[] = [];

    const pageAliases: Record<string, string[]> = {
      blog: ["blog", "articles", "posts", "news"],
      about: ["about", "about-us", "aboutus", "our-story", "who-we-are", "company"],
      contact: [
        "contact", "contact-us", "contactus", "get-in-touch", "reach-us",
        "page/contact", "pages/contact", "support",
      ],
      services: ["services", "what-we-do", "solutions", "offerings"],
      team: ["team", "our-team", "people", "leadership", "about/team"],
      returns: [
        "returns", "refund-policy", "refund", "policies/refund-policy",
        "policies/refund", "return-policy",
      ],
      shipping: [
        "shipping", "shipping-policy", "delivery", "policies/shipping-policy",
        "policies/shipping",
      ],
      products: ["products", "shop", "store", "collections"],
      cart: ["cart", "basket", "checkout"],
      pricing: ["pricing", "plans", "packages"],
      features: ["features", "capabilities", "platform"],
      documentation: ["docs", "documentation", "help", "knowledge-base", "faq"],
      portfolio: ["portfolio", "work", "projects", "case-studies"],
      archive: ["archive", "archives"],
      categories: ["categories", "topics", "tags"],
      privacy: [
        "privacy", "privacy-policy", "privacypolicy", "data-privacy",
        "privacy-statement", "policies/privacy-policy", "policies/privacy",
      ],
      terms: [
        "terms", "terms-of-service", "terms-and-conditions", "tos",
        "terms-of-use", "termsofservice", "policies/terms-of-service",
      ],
    };

    // Project settings can pin a key page to a custom path (e.g. contact at
    // /launch-your-vision) — that path becomes the highest-priority alias
    for (const [key, customPath] of Object.entries(this.customPagePaths)) {
      const alias = customPath.replace(/^\/+/, "").toLowerCase();
      if (!alias) continue;
      pageAliases[key] = [alias, ...(pageAliases[key] || [key])];
    }

    for (const expected of expectedPages) {
      const aliases = pageAliases[expected] || [expected];
      let foundUrl: string | undefined;

      const found = this.scanResults.some((r) => {
        const path = new URL(r.url).pathname.toLowerCase();
        const matched = aliases.some(
          (alias) =>
            path.includes(alias.toLowerCase()) ||
            path === `/${alias.toLowerCase()}` ||
            path === `/${alias.toLowerCase()}/`,
        );

        if (matched) {
          foundUrl = r.url;
        }
        return matched;
      });

      if (found) {
        // If we found it with an alias, note what we found
        const actualPath = foundUrl ? new URL(foundUrl).pathname : expected;
        foundPages.push(`${expected} (found as ${actualPath})`);
      } else {
        // Only penalize for truly missing essential pages
        if (["about", "contact"].includes(expected)) {
          missingPages.push(expected);
          score -= 15; // Higher penalty for essential pages
        } else {
          missingPages.push(expected);
          score -= 8; // Lower penalty for type-specific pages
        }
      }
    }

    const smartDetections: Record<string, { anchor: RegExp; heading: RegExp; schema?: RegExp }> = {
      contact: {
        anchor: /\b(contact|get in touch|reach out|reach us|send.{0,5}message|talk to us|write to us|enquir|inquir|let'?s talk|let'?s chat|book a call|schedule a call)\b/i,
        heading: /\b(contact|get in touch|reach out|send.{0,5}message|talk to us|write to us|enquir|inquir|drop.{0,5}(a )?line|let'?s (talk|chat|connect))\b/i,
        schema: /contactpage/i,
      },
      privacy: {
        anchor: /\b(privacy|privacy policy|data privacy|data protection)\b/i,
        heading: /\b(privacy|data (privacy|protection)|personal (data|information))\b/i,
      },
      terms: {
        anchor: /\b(terms|terms of (service|use)|terms (and|&) conditions|legal)\b/i,
        heading: /\b(terms of (service|use)|terms (and|&) conditions|legal (notice|terms))\b/i,
      },
    };

    for (const [pageType, patterns] of Object.entries(smartDetections)) {
      if (!missingPages.includes(pageType)) continue;
      const match = this.detectPageSmart(patterns.anchor, patterns.heading, patterns.schema);
      if (match) {
        const index = missingPages.indexOf(pageType);
        missingPages.splice(index, 1);
        foundPages.push(`${pageType} (${match})`);
        score += ["about", "contact"].includes(pageType) ? 15 : 8;
      }
    }

    return {
      score: Math.max(0, score),
      expectedPages,
      foundPages,
      missingPages,
      siteType,
    };
  }

  private detectPageSmart(anchorPattern: RegExp, headingPattern: RegExp, schemaPattern?: RegExp): string | null {
    for (const r of this.scanResults) {
      for (const link of r.internal_links) {
        if (anchorPattern.test(link.anchor_text)) {
          const path = new URL(link.url).pathname;
          return `nav link "${link.anchor_text}" → ${path}`;
        }
      }
    }

    for (const r of this.scanResults) {
      const allHeadings = [...r.h1s, ...r.h2s];
      if (allHeadings.some((h) => headingPattern.test(h))) {
        const path = new URL(r.url).pathname;
        return `heading match on ${path}`;
      }
    }

    if (schemaPattern) {
      for (const r of this.scanResults) {
        if (r.schema_types?.some((t) => schemaPattern.test(t))) {
          const path = new URL(r.url).pathname;
          return `schema match on ${path}`;
        }
      }
    }

    return null;
  }

  /**
   * Detect site type - IMPROVED VERSION
   */
  private detectSiteType(): string {
    const allUrls = this.scanResults.map((r) => r.url.toLowerCase()).join(" ");

    // E-commerce indicators
    if (
      allUrls.includes("/products") ||
      allUrls.includes("/shop") ||
      allUrls.includes("/cart")
    ) {
      return "ecommerce";
    }

    // SaaS indicators
    if (
      allUrls.includes("/pricing") ||
      (allUrls.includes("/features") && allUrls.includes("/pricing"))
    ) {
      return "saas";
    }

    // Blog/Content site - check for multiple article pages
    const blogIndicators = ["/blog/", "/articles/", "/posts/"];
    const blogPageCount = this.scanResults.filter((r) =>
      blogIndicators.some((ind) => r.url.toLowerCase().includes(ind)),
    ).length;
    if (blogPageCount >= 3) {
      return "blog";
    }

    // Portfolio indicators
    if (
      allUrls.includes("/portfolio") ||
      allUrls.includes("/projects") ||
      (allUrls.includes("/work") && !allUrls.includes("/how-we-work"))
    ) {
      return "portfolio";
    }

    return "business";
  }

  /**
   * Get expected pages - IMPROVED VERSION
   */
  private getExpectedPages(siteType: string): string[] {
    const basePages = ["about", "contact", "privacy", "terms"];

    const typeSpecific: Record<string, string[]> = {
      ecommerce: ["products", "cart", "shipping", "returns"],
      saas: ["pricing", "features", "documentation"],
      blog: ["blog", "archive", "categories"],
      portfolio: ["portfolio", "services"],
      business: ["services", "team"],
    };

    return [...basePages, ...(typeSpecific[siteType] || typeSpecific.business)];
  }

  // ... [Keep all other existing methods unchanged from original file] ...
  // These include: analyzeModernization, analyzePerformance, analyzeDesign,
  // analyzeModernStandards, generateRecommendations, calculateOverallScore, extractScripts

  /**
   * Analyze modernization (jQuery, old patterns, etc.)
   */
  private async analyzeModernization(): Promise<ModernizationAnalysis> {
    console.log("📊 Analyzing modernization...");

    const findings: string[] = [];
    let score = 100;
    let usesJQuery = false;
    let usesOldFrameworks = false;
    let hasModernBuildTools = false;

    // Check for jQuery across all pages
    for (const result of this.scanResults) {
      const scripts = this.extractScripts(result);

      if (scripts.some((s) => s.includes("jquery"))) {
        usesJQuery = true;
        break;
      }
    }

    if (usesJQuery) {
      score -= 20;
      findings.push(
        "Site uses jQuery - consider modern alternatives like vanilla JS or React",
      );
    }

    // Check for modern frameworks via script/link paths
    const hasModernFramework = this.scanResults.some((result) => {
      const scripts = this.extractScripts(result);
      const linkTags = this.extractLinkTags(result);
      const allPaths = [...scripts, ...linkTags].map((s) => s.toLowerCase());
      return allPaths.some(
        (s) =>
          s.includes("react") ||
          s.includes("vue") ||
          s.includes("_next/") ||
          s.includes("nuxt"),
      );
    });

    if (hasModernFramework) {
      score += 10;
      hasModernBuildTools = true;
      findings.push("Modern JavaScript framework detected");
    } else {
      score -= 15;
      findings.push("No modern JavaScript framework detected");
    }

    return {
      score: Math.max(0, Math.min(100, score)),
      usesJQuery,
      usesOldFrameworks,
      hasModernBuildTools,
      findings,
    };
  }

  /**
   * Analyze performance
   */
  private async analyzePerformance(): Promise<PerformanceAnalysis> {
    console.log("⚡ Analyzing performance...");

    let score = 100;
    const findings: string[] = [];

    // Calculate averages
    const validLoadTimes = this.scanResults.filter((r) => r.load_time_ms > 0);
    const avgLoadTime =
      validLoadTimes.length > 0
        ? validLoadTimes.reduce((sum, r) => sum + r.load_time_ms, 0) /
          validLoadTimes.length
        : 0;

    const validFBT = this.scanResults.filter((r) => r.first_byte_time_ms > 0);
    const avgFirstByteTime =
      validFBT.length > 0
        ? validFBT.reduce((sum, r) => sum + r.first_byte_time_ms, 0) /
          validFBT.length
        : 0;

    const validSizes = this.scanResults.filter((r) => r.size_bytes > 0);
    const avgPageSize =
      validSizes.length > 0
        ? validSizes.reduce((sum, r) => sum + r.size_bytes, 0) /
          validSizes.length
        : 0;

    // Evaluate load time
    if (avgLoadTime > 5000) {
      score -= 30;
      findings.push(
        `Average load time is slow (${(avgLoadTime / 1000).toFixed(
          2,
        )}s) - optimize critical resources`,
      );
    } else if (avgLoadTime > 3000) {
      score -= 15;
      findings.push(
        `Average load time could be improved (${(avgLoadTime / 1000).toFixed(
          2,
        )}s)`,
      );
    } else {
      findings.push(
        `Good load time (${(avgLoadTime / 1000).toFixed(2)}s average)`,
      );
    }

    // Evaluate first byte time
    if (avgFirstByteTime > 1000) {
      score -= 15;
      findings.push(
        `Server response time is slow (${avgFirstByteTime.toFixed(
          0,
        )}ms) - optimize server configuration`,
      );
    }

    // Evaluate page size
    const avgSizeMB = avgPageSize / (1024 * 1024);
    if (avgSizeMB > 3) {
      score -= 20;
      findings.push(
        `Large page size (${avgSizeMB.toFixed(
          2,
        )}MB) - optimize images and assets`,
      );
    } else if (avgSizeMB > 1.5) {
      score -= 10;
      findings.push(`Page size could be reduced (${avgSizeMB.toFixed(2)}MB)`);
    }

    // Find slowest pages
    const slowestPages = this.scanResults
      .filter((r) => r.load_time_ms > 0)
      .sort((a, b) => (b.load_time_ms || 0) - (a.load_time_ms || 0))
      .slice(0, 5)
      .map((r) => ({
        url: r.url,
        loadTime: r.load_time_ms || 0,
      }));

    // CLS risk: images without explicit dimensions
    const totalClsRisk = this.scanResults.reduce((sum, r) => sum + (r.cls_risk_images || 0), 0);
    if (totalClsRisk > 5) {
      score -= 10;
      findings.push(`${totalClsRisk} images lack explicit width/height attributes (CLS risk)`);
    } else if (totalClsRisk > 0) {
      findings.push(`${totalClsRisk} images without explicit dimensions (minor CLS risk)`);
    }

    // Resource hints
    const hasAnyHints = this.scanResults.some(r =>
      r.resource_hints && (r.resource_hints.preconnect.length > 0 || r.resource_hints.preload.length > 0)
    );
    if (!hasAnyHints) {
      score -= 5;
      findings.push("No resource hints (preconnect/preload) found — add hints for third-party origins");
    }

    // JS rendering dependency
    const jsGapPages = this.scanResults.filter(r => r.js_rendering_gap && r.js_rendering_gap.delta_percent > 50);
    if (jsGapPages.length > 0) {
      score -= 10;
      findings.push(`${jsGapPages.length} page(s) have critical JS rendering dependency — content invisible without JavaScript`);
    }

    return {
      score: Math.max(0, score),
      avgLoadTime,
      avgFirstByteTime,
      avgPageSize,
      slowestPages,
      findings,
    };
  }

  /**
   * Analyze design elements.
   *
   * Honesty note: a ScanResult carries no CSS and no rendered body text, so we
   * only report design signals we can actually observe from captured data:
   *   - Web fonts, from real <link> stylesheet hrefs (Google Fonts family names
   *     are in the URL; other providers are named without families).
   *   - Social presence, from the page's external link hostnames.
   * We intentionally do NOT report colours (never captured) or a copyright year
   * (needs footer text we don't store) rather than guess from a regex over the
   * serialized result, which produced empty/misleading output before.
   */
  private async analyzeDesign(): Promise<DesignAnalysis> {
    console.log("🎨 Analyzing design...");

    let score = 100;
    const findings: string[] = [];
    const fonts: string[] = [];
    const socialPlatforms: string[] = [];

    const SOCIAL_DOMAINS: Record<string, string> = {
      "facebook.com": "facebook",
      "twitter.com": "X (Twitter)",
      "x.com": "X (Twitter)",
      "linkedin.com": "linkedin",
      "instagram.com": "instagram",
      "youtube.com": "youtube",
      "tiktok.com": "tiktok",
      "pinterest.com": "pinterest",
    };

    const hostnameOf = (u: string): string => {
      try {
        return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    };

    const addFont = (name: string) => {
      const f = name.trim();
      if (f && !fonts.includes(f) && fonts.length < 8) fonts.push(f);
    };

    for (const result of this.scanResults.slice(0, 5)) {
      // Web fonts from real stylesheet hrefs (+ any font links in the markup).
      const assetUrls = [
        ...(Array.isArray(result.stylesheet_hrefs) ? result.stylesheet_hrefs : []),
        ...(Array.isArray(result.script_srcs) ? result.script_srcs : []),
      ];
      for (const href of assetUrls) {
        const lower = href.toLowerCase();
        if (lower.includes("fonts.googleapis.com") || lower.includes("fonts.gstatic.com")) {
          // Parse family names from ?family=Open+Sans:400&family=Inter:wght@400
          try {
            const url = new URL(href);
            const families = url.searchParams.getAll("family");
            for (const fam of families) {
              const name = fam.split(":")[0].replace(/\+/g, " ").trim();
              addFont(name);
            }
          } catch {
            /* ignore unparseable href */
          }
        } else if (lower.includes("use.typekit.net") || lower.includes("fonts.adobe.com")) {
          addFont("Adobe Fonts");
        }
      }

      // Social presence from actual external link hostnames (precise — not a
      // substring match over the whole serialized page).
      for (const link of result.external_links || []) {
        const host = hostnameOf(link.url);
        if (!host) continue;
        for (const domain of Object.keys(SOCIAL_DOMAINS)) {
          if ((host === domain || host.endsWith(`.${domain}`)) && !socialPlatforms.includes(SOCIAL_DOMAINS[domain])) {
            socialPlatforms.push(SOCIAL_DOMAINS[domain]);
          }
        }
      }
    }

    const hasSocialLinks = socialPlatforms.length > 0;

    if (fonts.length > 0) {
      findings.push(`Web fonts detected: ${fonts.slice(0, 3).join(", ")}`);
    }

    if (!hasSocialLinks) {
      score -= 10;
      findings.push("No social media links detected");
    } else {
      findings.push(`Social media presence: ${socialPlatforms.length} platform(s)`);
    }

    return {
      score: Math.max(0, score),
      fonts,
      hasSocialLinks,
      socialPlatforms,
      findings,
    };
  }

  /**
   * Analyze modern web standards
   */
  private async analyzeModernStandards(): Promise<ModernStandardsAnalysis> {
    console.log("🔒 Analyzing modern standards...");

    let score = 100;
    const findings: string[] = [];

    const usesHttps = this.baseUrl.startsWith("https://");
    let hasValidFavicon = false;
    let hasRobotsTxt = false;
    let hasSitemap = false;
    let mobileResponsive = false;

    // Check for HTTPS
    if (!usesHttps) {
      score -= 30;
      findings.push("Site not using HTTPS - major security concern");
    } else {
      findings.push("Site properly uses HTTPS");
    }

    // Check for favicon. Primary signal is the favicon_url the scanner extracts
    // from the page head; fall back to scanning the serialised result for a
    // favicon reference (covers older shapes and /favicon.ico mentions).
    hasValidFavicon = this.scanResults.some((r) => {
      if (r.favicon_url) return true;
      const content = JSON.stringify(r).toLowerCase();
      return (
        content.includes("favicon") ||
        content.includes("apple-touch-icon") ||
        content.includes('rel="icon"') ||
        content.includes("rel='icon'")
      );
    });

    if (!hasValidFavicon) {
      score -= 5;
      findings.push("No favicon detected");
    }

    // Check for mobile viewport meta tag
    mobileResponsive = this.scanResults.some((r) => {
      const content = JSON.stringify(r);
      return content.includes('name="viewport"');
    });

    if (!mobileResponsive) {
      score -= 20;
      findings.push("No mobile viewport meta tag - site may not be responsive");
    } else {
      findings.push("Mobile-friendly viewport detected");
    }

    // Actually fetch robots.txt and sitemap.xml
    try {
      const baseUrlObj = new URL(this.baseUrl);
      const robotsUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}/robots.txt`;
      const controller1 = new AbortController();
      const timeout1 = setTimeout(() => controller1.abort(), 8000);
      const robotsResp = await proxyFetch(robotsUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller1.signal,
      });
      clearTimeout(timeout1);
      hasRobotsTxt = robotsResp.ok;
    } catch {
      hasRobotsTxt = false;
    }

    if (!hasRobotsTxt) {
      score -= 5;
      findings.push("No robots.txt found");
    } else {
      findings.push("robots.txt found");
    }

    try {
      const baseUrlObj = new URL(this.baseUrl);
      const sitemapUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}/sitemap.xml`;
      const controller2 = new AbortController();
      const timeout2 = setTimeout(() => controller2.abort(), 8000);
      const sitemapResp = await proxyFetch(sitemapUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller2.signal,
      });
      clearTimeout(timeout2);
      hasSitemap = sitemapResp.ok;
    } catch {
      hasSitemap = false;
    }

    if (!hasSitemap) {
      score -= 10;
      findings.push("No sitemap.xml found");
    } else {
      findings.push("sitemap.xml found");
    }

    // Accessibility checks
    const homepage = this.scanResults.find(r => new URL(r.url).pathname === "/" || new URL(r.url).pathname === "");
    const hasHtmlLang = this.scanResults.some(r => r.accessibility?.html_lang);
    if (!hasHtmlLang) {
      score -= 10;
      findings.push("Missing lang attribute on <html> — hurts accessibility and SEO");
    }

    const totalMissingLabels = this.scanResults.reduce((sum, r) => sum + (r.accessibility?.form_labels_missing || 0), 0);
    if (totalMissingLabels > 0) {
      score -= 5;
      findings.push(`${totalMissingLabels} form input(s) missing associated labels`);
    }

    if (homepage?.accessibility) {
      if (homepage.accessibility.aria_landmarks.length < 2) {
        score -= 5;
        findings.push("Homepage has insufficient ARIA landmarks (nav, main, header, footer)");
      }
      if (!homepage.accessibility.has_skip_nav) {
        score -= 3;
        findings.push("No skip navigation link found");
      }
    }

    // Cookie consent
    const hasCookieConsent = this.scanResults.some(r => r.has_cookie_consent);
    if (!hasCookieConsent) {
      findings.push("No cookie consent mechanism detected");
    }

    return {
      score: Math.max(0, score),
      usesHttps,
      hasValidFavicon,
      hasRobotsTxt,
      hasSitemap,
      mobileResponsive,
      findings,
    };
  }

  /**
   * Generate recommendations based on analysis
   */
  private generateRecommendations(
    analysis: AuditAnalysis,
  ): AuditRecommendation[] {
    const recommendations: AuditRecommendation[] = [];

    // Modernization recommendations
    if (analysis.modernization.usesJQuery) {
      recommendations.push({
        type: "important",
        category: "modernization",
        title: "Modernize JavaScript",
        description:
          "Site uses jQuery which is outdated. Consider migrating to vanilla JavaScript or a modern framework.",
        impact: "Improved performance and maintainability",
        effort: "high",
      });
    }

    // Performance recommendations
    if (analysis.performance.avgLoadTime > 3000) {
      recommendations.push({
        type: "critical",
        category: "performance",
        title: "Improve Page Load Speed",
        description: `Average load time is ${(
          analysis.performance.avgLoadTime / 1000
        ).toFixed(2)}s. Optimize images, minify assets, and implement caching.`,
        impact: "Better user experience and SEO rankings",
        effort: "medium",
      });
    }

    // Completeness recommendations
    if (analysis.completeness.missingPages.length > 0) {
      const essentialMissing = analysis.completeness.missingPages.filter((p) =>
        ["about", "contact"].includes(p),
      );
      if (essentialMissing.length > 0) {
        recommendations.push({
          type: "important",
          category: "completeness",
          title: "Add Missing Essential Pages",
          description: `Missing important pages: ${essentialMissing.join(
            ", ",
          )}. These build trust with visitors.`,
          impact: "Better user trust and credibility",
          effort: "low",
        });
      }
    }

    // Standards recommendations
    if (!analysis.modernStandards.usesHttps) {
      recommendations.push({
        type: "critical",
        category: "standards",
        title: "Implement HTTPS",
        description:
          "Site not using HTTPS. This is a security risk and hurts SEO.",
        impact: "Critical for security and user trust",
        effort: "low",
      });
    }

    if (!analysis.modernStandards.hasSitemap) {
      recommendations.push({
        type: "important",
        category: "standards",
        title: "Add XML Sitemap",
        description:
          "No sitemap detected. Create and submit to search engines.",
        impact: "Better search engine indexing",
        effort: "low",
      });
    }

    // Design recommendations
    if (!analysis.design.hasSocialLinks) {
      recommendations.push({
        type: "nice-to-have",
        category: "design",
        title: "Add Social Media Links",
        description:
          "No social media links found. Add links to your social profiles.",
        impact: "Improved social presence and engagement",
        effort: "low",
      });
    }

    // CLS risk recommendations
    const totalClsRisk = this.scanResults.reduce((sum, r) => sum + (r.cls_risk_images || 0), 0);
    if (totalClsRisk > 5) {
      recommendations.push({
        type: "important",
        category: "performance",
        title: "Add Width/Height to Images",
        description: `${totalClsRisk} images lack explicit width/height attributes, causing Cumulative Layout Shift (CLS).`,
        impact: "Reduces layout shift and improves Core Web Vitals",
        effort: "low",
      });
    }

    // Accessibility recommendations
    if (analysis.modernStandards.findings.some(f => f.includes("Missing lang"))) {
      recommendations.push({
        type: "important",
        category: "standards",
        title: "Add HTML lang Attribute",
        description: "The <html> tag is missing a lang attribute. This hurts accessibility and SEO.",
        impact: "Screen readers and search engines use this to determine page language",
        effort: "low",
      });
    }

    if (analysis.modernStandards.findings.some(f => f.includes("form input"))) {
      recommendations.push({
        type: "important",
        category: "standards",
        title: "Add Labels to Form Inputs",
        description: "Some form inputs are missing associated labels, making them inaccessible.",
        impact: "Required for screen reader users and improves UX",
        effort: "low",
      });
    }

    // Resource hints recommendations
    if (analysis.performance.findings.some(f => f.includes("No resource hints"))) {
      recommendations.push({
        type: "nice-to-have",
        category: "performance",
        title: "Add Resource Hints",
        description: "No preconnect or preload hints found. Add hints for critical third-party origins.",
        impact: "Reduces connection time to external resources",
        effort: "low",
      });
    }

    // JS rendering dependency recommendations
    if (analysis.performance.findings.some(f => f.includes("JS rendering dependency"))) {
      recommendations.push({
        type: "important",
        category: "performance",
        title: "Reduce JavaScript Rendering Dependency",
        description: "Some pages are mostly invisible without JavaScript. Search engines may not index this content.",
        impact: "Content visibility for crawlers that don't execute JavaScript",
        effort: "high",
      });
    }

    // Cookie consent recommendation
    if (analysis.modernStandards.findings.some(f => f.includes("cookie consent"))) {
      recommendations.push({
        type: "important",
        category: "standards",
        title: "Add Cookie Consent Mechanism",
        description: "No cookie consent banner detected. Required for GDPR/CCPA compliance.",
        impact: "Legal compliance and user trust",
        effort: "medium",
      });
    }

    // Privacy/Terms recommendations
    if (analysis.completeness.missingPages.includes("privacy")) {
      recommendations.push({
        type: "important",
        category: "completeness",
        title: "Add Privacy Policy Page",
        description: "No privacy policy page found. Required for legal compliance and user trust.",
        impact: "Legal requirement for most jurisdictions",
        effort: "medium",
      });
    }

    if (analysis.completeness.missingPages.includes("terms")) {
      recommendations.push({
        type: "important",
        category: "completeness",
        title: "Add Terms of Service Page",
        description: "No terms of service page found. Important for legal protection.",
        impact: "Protects your business legally",
        effort: "medium",
      });
    }

    return recommendations;
  }

  /**
   * Calculate overall score from all categories
   */
  private calculateOverallScore(analysis: AuditAnalysis): number {
    const weights = {
      modernization: 0.15,
      performance: 0.25,
      completeness: 0.2,
      design: 0.15,
      modernStandards: 0.25,
    };

    const weightedScore =
      analysis.modernization.score * weights.modernization +
      analysis.performance.score * weights.performance +
      analysis.completeness.score * weights.completeness +
      analysis.design.score * weights.design +
      analysis.modernStandards.score * weights.modernStandards;

    return Math.round(weightedScore);
  }

  /**
   * Helper: the real <script src> URLs captured from the page markup, plus the
   * page URL itself (for platform indicators in the path).
   */
  private extractScripts(result: ScanResult): string[] {
    // Real <script src> URLs captured from the page markup (scanner populates
    // result.script_srcs). This replaces the old approach of guessing scripts
    // from anchor hrefs, which never saw actual bundles and produced false
    // "no modern framework" verdicts on genuine React/Next/Vue sites.
    const scripts = Array.isArray(result.script_srcs) ? [...result.script_srcs] : [];

    // Also include the page URL itself for platform indicators in the path.
    scripts.push(result.url);

    return scripts;
  }

  /**
   * Helper: the real <link rel=stylesheet href> URLs captured from the page
   * markup (used for platform/font detection).
   */
  private extractLinkTags(result: ScanResult): string[] {
    // Real <link rel=stylesheet href> URLs captured from the page markup
    // (scanner populates result.stylesheet_hrefs), e.g. cdn.shopify.com or
    // /_next/static stylesheets used for platform detection.
    return Array.isArray(result.stylesheet_hrefs) ? [...result.stylesheet_hrefs] : [];
  }
}
