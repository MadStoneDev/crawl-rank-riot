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
      hasModernBuildTools = true;
      findings.push("Site uses modern framework - excellent!");
    } else {
      score -= 10;
      findings.push(
        "Consider using a modern framework for better maintainability",
      );
    }

    return {
      score: Math.max(0, score),
      usesJQuery,
      usesOldFrameworks,
      hasModernBuildTools,
      findings,
    };
  }

  /**
   * Analyze performance metrics
   */
  private async analyzePerformance(): Promise<PerformanceAnalysis> {
    console.log("⚡ Analyzing performance...");

    const findings: string[] = [];
    let score = 100;

    const avgLoadTime =
      this.scanResults.reduce((sum, r) => sum + (r.load_time_ms || 0), 0) /
      this.scanResults.length;
    const avgFirstByteTime =
      this.scanResults.reduce(
        (sum, r) => sum + (r.first_byte_time_ms || 0),
        0,
      ) / this.scanResults.length;
    const avgPageSize =
      this.scanResults.reduce((sum, r) => sum + (r.size_bytes || 0), 0) /
      this.scanResults.length;

    // Score based on load time
    if (avgLoadTime > 5000) {
      score -= 40;
      findings.push(
        `Average load time is ${(avgLoadTime / 1000).toFixed(
          2,
        )}s - should be under 3s`,
      );
    } else if (avgLoadTime > 3000) {
      score -= 20;
      findings.push(
        `Average load time is ${(avgLoadTime / 1000).toFixed(
          2,
        )}s - could be faster`,
      );
    } else {
      findings.push(`Excellent load time: ${(avgLoadTime / 1000).toFixed(2)}s`);
    }

    // Score based on TTFB
    if (avgFirstByteTime > 800) {
      score -= 20;
      findings.push(
        `Slow server response time (${avgFirstByteTime}ms) - optimize backend or use CDN`,
      );
    } else if (avgFirstByteTime > 400) {
      score -= 10;
      findings.push(
        `Server response time could be improved (${avgFirstByteTime}ms)`,
      );
    }

    // Score based on page size
    const avgSizeMB = avgPageSize / (1024 * 1024);
    if (avgSizeMB > 3) {
      score -= 20;
      findings.push(
        `Large average page size (${avgSizeMB.toFixed(
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
   * Analyze site completeness (expected pages)
   */
  private async analyzeCompleteness(): Promise<CompletenessAnalysis> {
    console.log("📋 Analyzing completeness...");

    let score = 100;
    const siteType = this.detectSiteType();
    const expectedPages = this.getExpectedPages(siteType);
    const foundPages: string[] = [];
    const missingPages: string[] = [];

    for (const expected of expectedPages) {
      const found = this.scanResults.some((r) => {
        const path = new URL(r.url).pathname.toLowerCase();
        return (
          path.includes(expected.toLowerCase()) ||
          path === `/${expected.toLowerCase()}` ||
          path === `/${expected.toLowerCase()}/`
        );
      });

      if (found) {
        foundPages.push(expected);
      } else {
        missingPages.push(expected);
        score -= 10;
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

  /**
   * Analyze tech stack
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

    // Analyze first few pages for tech detection
    const samplesToCheck = this.scanResults.slice(0, 10);

    for (const result of samplesToCheck) {
      const content = JSON.stringify(result).toLowerCase();
      const scripts = this.extractScripts(result);

      // Detect CMS
      if (content.includes("wp-content") || content.includes("wordpress")) {
        hasWordPress = true;
        cms = "WordPress";
      }
      if (content.includes("shopify") || content.includes("myshopify")) {
        hasShopify = true;
        cms = "Shopify";
      }

      // Detect frameworks
      if (
        content.includes("react") ||
        scripts.some((s) => s.includes("react"))
      ) {
        hasReact = true;
        framework = "React";
      }
      if (content.includes("vue") || scripts.some((s) => s.includes("vue"))) {
        hasVue = true;
        framework = "Vue";
      }
      if (content.includes("_next") || content.includes("next/")) {
        hasNextJs = true;
        framework = "Next.js";
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

    // Generate findings
    if (cms) {
      findings.push(`Site built on ${cms}`);
    }
    if (framework) {
      findings.push(`Using ${framework} framework`);
    }
    if (libraries.length > 0) {
      findings.push(`Libraries detected: ${libraries.join(", ")}`);
    }
    if (analytics.length === 0) {
      findings.push(
        "No analytics detected - consider adding Google Analytics or similar",
      );
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
    }

    // Check for social media links
    const allExternalLinks = this.scanResults.flatMap((r) => r.external_links);
    const socialDomains = [
      "facebook.com",
      "twitter.com",
      "instagram.com",
      "linkedin.com",
      "youtube.com",
      "tiktok.com",
    ];

    for (const link of allExternalLinks) {
      for (const domain of socialDomains) {
        if (link.url.includes(domain)) {
          hasSocialLinks = true;
          const platform = domain.replace(".com", "");
          if (!socialPlatforms.includes(platform)) {
            socialPlatforms.push(platform);
          }
        }
      }
    }

    // Look for copyright year
    for (const result of this.scanResults) {
      const content = JSON.stringify(result);
      const yearMatches = content.match(/©\s*(\d{4})|copyright\s*(\d{4})/i);
      if (yearMatches) {
        const year = parseInt(yearMatches[1] || yearMatches[2]);
        if (year >= 2020 && year <= new Date().getFullYear()) {
          copyrightYear = year;
          break;
        }
      }
    }

    // Score based on findings
    if (!copyrightYear || copyrightYear < new Date().getFullYear() - 2) {
      score -= 15;
      findings.push("Copyright year is outdated or missing");
    }

    if (!hasSocialLinks) {
      score -= 10;
      findings.push("No social media links found - consider adding them");
    } else {
      findings.push(`Social presence on: ${socialPlatforms.join(", ")}`);
    }

    if (fonts.length === 0) {
      score -= 5;
      findings.push(
        "Using system fonts only - consider web fonts for better branding",
      );
    } else {
      findings.push(`Fonts detected: ${fonts.slice(0, 3).join(", ")}`);
    }

    return {
      score: Math.max(0, score),
      colors,
      fonts,
      copyrightYear,
      hasSocialLinks,
      socialPlatforms,
      findings,
    };
  }

  /**
   * Analyze modern web standards
   */
  private async analyzeModernStandards(): Promise<ModernStandardsAnalysis> {
    console.log("✨ Analyzing modern standards...");

    let score = 100;
    const findings: string[] = [];

    const usesHttps = this.baseUrl.startsWith("https://");
    const hasValidFavicon = this.scanResults.some((r) =>
      r.images.some((img) => img.src.includes("favicon")),
    );

    // Check for robots.txt and sitemap
    const hasRobotsTxt = this.scanResults.some((r) =>
      r.url.includes("robots.txt"),
    );
    const hasSitemap = this.scanResults.some(
      (r) => r.url.includes("sitemap.xml") || r.url.includes("sitemap"),
    );

    // Basic mobile responsiveness check via viewport meta
    const mobileResponsive = this.scanResults.some((r) => {
      const content = JSON.stringify(r);
      return (
        content.includes("viewport") && content.includes("width=device-width")
      );
    });

    // Score
    if (!usesHttps) {
      score -= 30;
      findings.push("CRITICAL: Site not using HTTPS - security risk");
    } else {
      findings.push("Site uses HTTPS ✓");
    }

    if (!hasValidFavicon) {
      score -= 10;
      findings.push("No favicon detected");
    }

    if (!hasRobotsTxt) {
      score -= 15;
      findings.push("No robots.txt found - important for SEO");
    }

    if (!hasSitemap) {
      score -= 15;
      findings.push("No sitemap detected - important for search engines");
    }

    if (!mobileResponsive) {
      score -= 20;
      findings.push(
        "Mobile viewport meta tag not found - may not be mobile-friendly",
      );
    } else {
      findings.push("Mobile responsive meta tags detected ✓");
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
   * Generate actionable recommendations
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
      recommendations.push({
        type: "important",
        category: "completeness",
        title: "Add Missing Essential Pages",
        description: `Missing pages: ${analysis.completeness.missingPages.join(
          ", ",
        )}`,
        impact: "Better user trust and navigation",
        effort: "low",
      });
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

  /**
   * Helper: Detect site type based on content
   */
  private detectSiteType(): string {
    const allUrls = this.scanResults.map((r) => r.url.toLowerCase()).join(" ");

    if (
      allUrls.includes("/products") ||
      allUrls.includes("/shop") ||
      allUrls.includes("/cart")
    ) {
      return "ecommerce";
    }
    if (allUrls.includes("/pricing") || allUrls.includes("/features")) {
      return "saas";
    }
    if (allUrls.includes("/blog") || allUrls.includes("/articles")) {
      return "blog";
    }
    if (
      allUrls.includes("/portfolio") ||
      allUrls.includes("/projects") ||
      allUrls.includes("/work")
    ) {
      return "portfolio";
    }

    return "business";
  }

  /**
   * Helper: Get expected pages based on site type
   */
  private getExpectedPages(siteType: string): string[] {
    const basePages = ["about", "contact"];

    const typeSpecific: Record<string, string[]> = {
      ecommerce: ["products", "shop", "cart", "shipping", "returns"],
      saas: ["pricing", "features", "documentation", "login", "signup"],
      blog: ["blog", "archive", "categories"],
      portfolio: ["portfolio", "work", "projects", "services"],
      business: ["services", "team", "testimonials"],
    };

    return [...basePages, ...(typeSpecific[siteType] || typeSpecific.business)];
  }
}
