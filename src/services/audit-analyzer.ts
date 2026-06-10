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

    const recommendations = this.generateRecommendations(analysis);
    const overallScore = this.calculateOverallScore(analysis);

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

    // Only set Shopify if no modern framework detected AND confidence is high
    if (shopifyConfidence >= 10 && !framework) {
      hasShopify = true;
      cms = "Shopify";
    }

    // Generate findings
    if (framework) {
      findings.push(`Modern framework detected: ${framework}`);
    }
    if (cms && !framework) {
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
   * Analyze design elements
   */
  private async analyzeDesign(): Promise<DesignAnalysis> {
    console.log("🎨 Analyzing design...");

    let score = 100;
    const findings: string[] = [];
    const colors = {
      primary: [] as string[],
      text: [] as string[],
      background: [] as string[],
    };
    const fonts: string[] = [];
    let copyrightYear: number | undefined;
    let hasSocialLinks = false;
    const socialPlatforms: string[] = [];

    // Extract fonts from meta tags and content
    for (const result of this.scanResults.slice(0, 5)) {
      const content = JSON.stringify(result);

      // Look for Google Fonts or font families
      const fontMatches = content.match(/font-family[:\s]+([^;}"]+)/gi);
      if (fontMatches) {
        fontMatches.forEach((match) => {
          const font = match.replace(/font-family[:\s]+/i, "").trim();
          if (!fonts.includes(font) && fonts.length < 5) {
            fonts.push(font);
          }
        });
      }

      // Look for copyright year — match "Copyright 2024" or "© 2024"
      const copyrightMatch = content.match(/(?:copyright|©)\s*(?:.*?)\b(20\d{2})\b/i);
      if (copyrightMatch) {
        const year = parseInt(copyrightMatch[1]);
        if (year > 2000 && (!copyrightYear || year > copyrightYear)) {
          copyrightYear = year;
        }
      }

      // Check for social links
      const socialDomains = [
        "facebook.com",
        "twitter.com",
        "x.com",
        "linkedin.com",
        "instagram.com",
        "youtube.com",
        "tiktok.com",
      ];

      socialDomains.forEach((domain) => {
        if (content.includes(domain) && !socialPlatforms.includes(domain)) {
          socialPlatforms.push(domain);
          hasSocialLinks = true;
        }
      });
    }

    // Evaluate design elements
    if (fonts.length > 0) {
      findings.push(`Fonts detected: ${fonts.slice(0, 3).join(", ")}`);
    }

    if (copyrightYear && copyrightYear < new Date().getFullYear()) {
      score -= 5;
      findings.push(`Copyright year outdated (${copyrightYear})`);
    } else if (copyrightYear === new Date().getFullYear()) {
      findings.push("Copyright year is current");
    }

    if (!hasSocialLinks) {
      score -= 10;
      findings.push("No social media links detected");
    } else {
      findings.push(
        `Social media presence: ${socialPlatforms.length} platforms`,
      );
    }

    return {
      score: Math.max(0, score),
      colors,
      fonts,
      copyrightYear,
      hasSocialLinks,
      socialPlatforms: socialPlatforms.map((d) => {
        const name = d.replace(".com", "");
        return name === "x" ? "X (Twitter)" : name;
      }),
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

    // Check for favicon
    hasValidFavicon = this.scanResults.some((r) => {
      const content = JSON.stringify(r);
      return content.includes("favicon.ico") || content.includes('rel="icon"');
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

    if (
      analysis.design.copyrightYear &&
      analysis.design.copyrightYear < new Date().getFullYear()
    ) {
      recommendations.push({
        type: "nice-to-have",
        category: "design",
        title: "Update Copyright Year",
        description: "Copyright year is outdated. Update to current year.",
        impact: "Shows site is actively maintained",
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
   * Helper: Extract script-like sources from scan result link URLs.
   * Since ScanResult doesn't store raw HTML, we infer script sources
   * from external link URLs that point to .js files or known CDN paths.
   */
  private extractScripts(result: ScanResult): string[] {
    const scripts: string[] = [];

    // Check external link URLs for JS file patterns
    for (const link of result.external_links) {
      const url = link.url.toLowerCase();
      if (
        url.endsWith(".js") ||
        url.includes("/js/") ||
        url.includes("cdn.") ||
        url.includes("_next/") ||
        url.includes("wp-content") ||
        url.includes("wp-includes")
      ) {
        scripts.push(link.url);
      }
    }

    // Check internal link URLs for JS/framework paths
    for (const link of result.internal_links) {
      const url = link.url.toLowerCase();
      if (
        url.endsWith(".js") ||
        url.includes("_next/") ||
        url.includes("/static/js/") ||
        url.includes("wp-content") ||
        url.includes("wp-includes")
      ) {
        scripts.push(link.url);
      }
    }

    // Also check the page URL itself for platform indicators
    scripts.push(result.url);

    return scripts;
  }

  /**
   * Helper: Extract link tag hrefs (stylesheets, etc.) from scan result.
   * Inferred from external links pointing to CSS/asset CDN paths.
   */
  private extractLinkTags(result: ScanResult): string[] {
    const links: string[] = [];

    for (const link of result.external_links) {
      const url = link.url.toLowerCase();
      if (
        url.endsWith(".css") ||
        url.includes("/css/") ||
        url.includes("cdn.shopify.com") ||
        url.includes("cdn.") ||
        url.includes("fonts.googleapis.com")
      ) {
        links.push(link.url);
      }
    }

    for (const link of result.internal_links) {
      const url = link.url.toLowerCase();
      if (url.endsWith(".css") || url.includes("/css/") || url.includes("/static/")) {
        links.push(link.url);
      }
    }

    return links;
  }
}
