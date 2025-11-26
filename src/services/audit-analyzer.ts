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

export class AuditAnalyzer {
  private scanResults: ScanResult[];
  private baseUrl: string;

  constructor(scanResults: ScanResult[], baseUrl: string) {
    this.scanResults = scanResults;
    this.baseUrl = baseUrl;
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
      const content = JSON.stringify(result).toLowerCase();
      const scripts = this.extractScripts(result);

      // Next.js detection (high priority)
      if (content.includes("_next/static") || content.includes("__next")) {
        nextJsConfidence += 10;
      }
      if (content.includes("next/") || content.includes("nextjs")) {
        nextJsConfidence += 5;
      }
      if (scripts.some((s) => s.includes("_next/") || s.includes("next-"))) {
        nextJsConfidence += 10;
      }

      // React detection
      if (scripts.some((s) => s.includes("react"))) {
        reactConfidence += 10;
      }
      if (content.includes("react") && !content.includes("reactivate")) {
        reactConfidence += 3;
      }

      // Shopify detection (be more specific)
      if (
        content.includes("cdn.shopify.com") ||
        content.includes("myshopify.com")
      ) {
        shopifyConfidence += 10;
      }
      if (
        content.includes("shopify.") &&
        !content.includes("not shopify") &&
        !content.includes("like shopify")
      ) {
        shopifyConfidence += 3;
      }

      // Detect CMS (WordPress)
      if (content.includes("wp-content") || content.includes("wp-includes")) {
        hasWordPress = true;
        cms = "WordPress";
      }

      // Detect Vue
      if (content.includes("vue") || scripts.some((s) => s.includes("vue"))) {
        hasVue = true;
      }

      // Detect libraries
      if (content.includes("jquery") && !libraries.includes("jQuery")) {
        libraries.push("jQuery");
      }
      if (content.includes("bootstrap") && !libraries.includes("Bootstrap")) {
        libraries.push("Bootstrap");
      }
      if (content.includes("tailwind") && !libraries.includes("Tailwind CSS")) {
        libraries.push("Tailwind CSS");
      }

      // Detect analytics
      if (content.includes("google-analytics") || content.includes("gtag")) {
        if (!analytics.includes("Google Analytics")) {
          analytics.push("Google Analytics");
        }
      }
      if (content.includes("gtm") || content.includes("googletagmanager")) {
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

    // Map of alternative names for common pages
    const pageAliases: Record<string, string[]> = {
      blog: ["blog", "articles", "posts", "news"],
      about: ["about", "about-us", "aboutus", "our-story", "who-we-are"],
      contact: [
        "contact",
        "contact-us",
        "contactus",
        "get-in-touch",
        "reach-us",
      ],
      services: ["services", "what-we-do", "solutions", "offerings"],
      team: ["team", "our-team", "people", "leadership", "about/team"],
    };

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

    // Check for contact form even if no /contact page
    const hasContactForm = this.scanResults.some((r) => {
      const content = JSON.stringify(r).toLowerCase();
      return (
        content.includes('type="email"') &&
        (content.includes("contact") ||
          content.includes("message") ||
          content.includes("inquiry"))
      );
    });

    if (hasContactForm && missingPages.includes("contact")) {
      // Remove contact from missing, add note
      const index = missingPages.indexOf("contact");
      missingPages.splice(index, 1);
      foundPages.push("contact (form found on another page)");
      score += 10; // Add back some of the penalty
    }

    return {
      score: Math.max(0, score),
      expectedPages,
      foundPages,
      missingPages,
      siteType,
    };
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
    const basePages = ["about", "contact"];

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

    // Check for modern frameworks
    const hasModernFramework = this.scanResults.some((result) => {
      const content = JSON.stringify(result);
      return (
        content.includes("react") ||
        content.includes("vue") ||
        content.includes("next") ||
        content.includes("nuxt")
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

      // Look for copyright year
      const copyrightMatch = content.match(/copyright.*?(\d{4})/i);
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
      socialPlatforms: socialPlatforms.map((d) =>
        d.replace(".com", "").replace("x", "X (Twitter)"),
      ),
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

    // Check for robots.txt and sitemap (would need to fetch these separately)
    // For now, check if sitemap is mentioned in any page
    hasSitemap = this.scanResults.some((r) => {
      return r.url.toLowerCase().includes("sitemap");
    });

    if (!hasSitemap) {
      score -= 10;
      findings.push("No sitemap detected");
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
   * Helper: Extract script sources from scan result
   */
  private extractScripts(result: ScanResult): string[] {
    const scripts: string[] = [];
    const content = JSON.stringify(result);

    const scriptMatches = content.match(/<script[^>]*src=["']([^"']+)["']/gi);
    if (scriptMatches) {
      scriptMatches.forEach((match) => {
        const srcMatch = match.match(/src=["']([^"']+)["']/i);
        if (srcMatch) {
          scripts.push(srcMatch[1]);
        }
      });
    }

    return scripts;
  }
}
