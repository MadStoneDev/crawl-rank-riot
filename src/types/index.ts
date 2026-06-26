export interface ApiResponse<T> {
  status: "success" | "error";
  message: string;
  data?: T;
  error?: {
    code: string;
    details?: any;
  };
}

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  concurrentRequests?: number;
  timeout?: number;
  excludePatterns?: RegExp[];
  checkSitemaps?: boolean;
  useHeadlessBrowser?: boolean;
  forceHeadless?: boolean;
  crawlMode?: "seo" | "audit";
  /** Per-project overrides from projects.settings */
  customSitemapPaths?: string[];
  seedPaths?: string[];
  wwwPreference?: "www" | "non-www";
}

export interface ScanResult {
  // Core information
  url: string;
  status: number;
  title?: string;
  meta_description?: string;
  depth: number;

  // Content analysis
  h1s: string[];
  h2s: string[];
  h3s: string[];
  h4s: string[];
  h5s: string[];
  h6s: string[];
  content_length: number;
  word_count: number;

  // Meta information
  canonical_url: string | null;
  is_indexable: boolean;
  has_robots_noindex: boolean;
  has_robots_nofollow: boolean;
  open_graph: Record<string, string>;
  twitter_card: Record<string, string>;

  // Links
  internal_links: Array<{
    url: string;
    anchor_text: string;
    rel_attributes: string[];
  }>;
  external_links: Array<{
    url: string;
    anchor_text: string;
    rel_attributes: string[];
  }>;

  // Media with size information
  images: Array<{
    src: string;
    alt: string;
    dimensions?: {
      width: number;
      height: number;
    };
    file_size_bytes?: number;
    loading?: string;
    srcset?: string;
    format?: string;
  }>;

  // Technical information
  redirect_url: string | null;
  is_redirect?: boolean;
  redirected_from?: string;
  redirect_chain?: string[];
  content_type: string;
  size_bytes: number;
  load_time_ms: number;
  first_byte_time_ms: number;
  security_headers?: Record<string, string>;
  has_viewport_meta?: boolean;
  has_mixed_content?: boolean;

  // Structured data
  structured_data: any[];
  schema_types: string[];

  // Asset counts
  js_count: number;
  css_count: number;

  // SEO analysis
  keywords: Array<{
    word: string;
    count: number;
  }>;
  heading_hierarchy_valid?: boolean;
  heading_hierarchy_issues?: string[];
  hreflang_tags?: Array<{ lang: string; url: string }>;
  canonical_is_self?: boolean;
  url_issues?: string[];

  // Form detection
  has_contact_form?: boolean;

  // Core Web Vitals proxies
  cls_risk_images?: number;
  lcp_candidate?: { type: string; element: string; size_bytes?: number };

  // Accessibility
  accessibility?: {
    html_lang?: string;
    form_labels_missing: number;
    aria_landmarks: string[];
    has_skip_nav: boolean;
    tabindex_misuse: number;
  };

  // Privacy & compliance
  has_cookie_consent?: boolean;

  // Resource hints
  resource_hints?: {
    preconnect: string[];
    preload: string[];
    prefetch: string[];
    dns_prefetch: string[];
  };

  // JS rendering dependency (set when HTTP→headless escalation occurs)
  js_rendering_gap?: {
    http_word_count: number;
    headless_word_count: number;
    delta_percent: number;
  };

  // Content fingerprint for duplicate detection
  content_hash?: string;

  // Readability
  readability_score?: number;

  // Crawler metadata
  scan_method?: "http" | "headless";
  // Platform/CMS detected from headers + HTML (e.g. "shopify", "wordpress").
  // In-memory only (not a pages column); used by the audit tech-stack analysis.
  detected_platform?: string | null;
  // Favicon URL declared in the page head (<link rel="...icon...">), if any.
  favicon_url?: string | null;
  scanned_at: string;
  errors?: string[];
  warnings?: string[];
}

export interface SiteLevelData {
  llms_txt?: {
    exists: boolean;
    content?: string;
    fields?: Record<string, string>;
  };
  robots_txt?: {
    exists: boolean;
    content?: string;
    ai_bots_blocked: string[];
    ai_bots_allowed: string[];
    blocked_paths: Array<{ user_agent: string; paths: string[] }>;
    sitemap_urls: string[];
  };
  sitemap_validation?: {
    found: boolean;
    url?: string;
    valid: boolean;
    url_count?: number;
    sub_sitemaps_scanned?: number;
    errors: string[];
    has_lastmod: boolean;
    urls_in_sitemap_not_crawled: string[];
    crawled_not_in_sitemap: string[];
  };
}

export type ScanStatus = "pending" | "in_progress" | "completed" | "failed";
export type ScanType = "seo" | "audit";

export interface Project {
  id: string;
  name: string;
  url: string;
  user_id: string;
  created_at: string;
  last_scan_at?: string;
  scan_frequency?: "weekly" | "monthly";
}

// NEW: Audit-specific types
export interface AuditAnalysis {
  modernization: ModernizationAnalysis;
  performance: PerformanceAnalysis;
  completeness: CompletenessAnalysis;
  techStack: TechStackAnalysis;
  design: DesignAnalysis;
  modernStandards: ModernStandardsAnalysis;
}

export interface ModernizationAnalysis {
  score: number; // 0-100
  usesJQuery: boolean;
  usesOldFrameworks: boolean;
  hasModernBuildTools: boolean;
  findings: string[];
}

export interface PerformanceAnalysis {
  score: number; // 0-100
  avgLoadTime: number;
  avgFirstByteTime: number;
  avgPageSize: number;
  slowestPages: Array<{
    url: string;
    loadTime: number;
  }>;
  findings: string[];
}

export interface CompletenessAnalysis {
  score: number; // 0-100
  expectedPages: string[];
  foundPages: string[];
  missingPages: string[];
  siteType?: string;
}

export interface TechStackAnalysis {
  framework?: string;
  cms?: string;
  libraries: string[];
  hasWordPress: boolean;
  hasShopify: boolean;
  hasReact: boolean;
  hasVue: boolean;
  hasNextJs: boolean;
  analytics: string[];
  findings: string[];
}

export interface DesignAnalysis {
  score: number; // 0-100
  colors: {
    primary: string[];
    text: string[];
    background: string[];
  };
  fonts: string[];
  copyrightYear?: number;
  hasSocialLinks: boolean;
  socialPlatforms: string[];
  findings: string[];
}

export interface ModernStandardsAnalysis {
  score: number; // 0-100
  usesHttps: boolean;
  hasValidFavicon: boolean;
  hasRobotsTxt: boolean;
  hasSitemap: boolean;
  mobileResponsive: boolean;
  findings: string[];
}

export interface AuditRecommendation {
  type: "critical" | "important" | "nice-to-have";
  category:
    | "modernization"
    | "performance"
    | "completeness"
    | "design"
    | "standards";
  title: string;
  description: string;
  impact: string;
  effort: "low" | "medium" | "high";
}

export interface AuditResult {
  scan_id: string;
  project_id: string;
  modernization_score: number;
  performance_score: number;
  completeness_score: number;
  conversion_score: number;
  overall_score: number;
  tech_stack: TechStackAnalysis;
  design_analysis: DesignAnalysis;
  missing_pages: string[];
  found_pages: string[];
  performance_metrics: PerformanceAnalysis;
  modern_standards: ModernStandardsAnalysis;
  recommendations: AuditRecommendation[];
}
