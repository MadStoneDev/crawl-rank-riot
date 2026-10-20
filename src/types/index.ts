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
  /**
   * Obey robots.txt Disallow/Allow + Crawl-delay for our UA (RB-01/RB-02).
   * Defaults to true. May only be set false for a domain-verified project where
   * the owner has authorised a full crawl (wired in Stage 4); until then nothing
   * sets it false, so the crawler always obeys robots.
   */
  obeyRobots?: boolean;
}

export interface ScanResult {
  // Core information
  url: string;
  status: number;
  title?: string;
  // Verbatim <title> is stored in `title` (P-01). This is an optional derived
  // display form with brand/suffix noise stripped — never used for length
  // checks or as the stored title.
  title_cleaned?: string;
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
  // Word count of the first substantial paragraph after the H1 — the "answer
  // block". 0 means no lead paragraph was found. Transient (used for AEO issue
  // detection); not persisted.
  lead_paragraph_words?: number;

  // Meta information
  canonical_url: string | null;
  // All distinct canonical targets found (resolved absolute). >1 means the page
  // declares conflicting canonicals (CN-01). `canonical_url` is the first.
  canonical_urls?: string[];
  // True when a <script type="application/ld+json"> block failed to parse
  // (malformed JSON), as opposed to no structured data at all (P-03).
  has_invalid_structured_data?: boolean;
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
    // Distinguishes a genuinely missing alt attribute (an issue) from a
    // deliberate alt="" on a decorative image (correct, not an issue).
    alt_state?: "absent" | "empty" | "present";
    dimensions?: {
      width: number;
      height: number;
    };
    file_size_bytes?: number;
    // True when we did not determine this image's byte size (beyond the per-page
    // probe cap, or the HEAD failed). Keeps "size unknown" distinct from "small"
    // so size-dependent checks never treat an unprobed image as fine (L-04).
    file_size_unknown?: boolean;
    loading?: string;
    srcset?: string;
    format?: string;
  }>;

  // Technical information
  redirect_url: string | null;
  is_redirect?: boolean;
  redirected_from?: string;
  redirect_chain?: string[];
  // Per-hop record of the redirect chain with each hop's HTTP status, so a
  // permanent (301/308) move can be told from a temporary (302/303/307) one
  // (R-01). redirect_chain keeps the bare URL list for existing consumers.
  redirect_hops?: Array<{ from: string; status: number; to: string }>;
  content_type: string;
  // True when the response is a non-HTML resource (PDF, image, feed, JSON …)
  // that returned 2xx (S-02). It is tracked for broken-link/redirect purposes
  // but is not a "page": no HTML content checks run and it is excluded from the
  // scored page set.
  is_non_html?: boolean;
  // True when a 2xx response is really a "page not found" page (soft 404, S-01).
  soft_404?: boolean;
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

  // Real asset URLs captured from the page markup (<script src>, <link
  // rel=stylesheet href>). In-memory only (not pages columns); used by the
  // audit tech-stack / modernization analysis to detect frameworks and CMSs
  // from actual bundle paths instead of guessing from anchor hrefs.
  script_srcs?: string[];
  stylesheet_hrefs?: string[];

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

  // Crawler metadata (render transparency — persisted to the pages table)
  scan_method?: "http" | "headless";
  // Platform/CMS detected from headers + HTML (e.g. "shopify", "wordpress").
  detected_platform?: string | null;
  // Where the page's JSON-LD lives: "server" = in the raw server HTML,
  // "client" = only after JS render (Google may miss it), "both", or "none".
  schema_source?: "server" | "client" | "both" | "none";
  // Favicon URL declared in the page head (<link rel="...icon...">), if any.
  favicon_url?: string | null;
  // True when the site served an incomplete TLS certificate chain (a missing
  // intermediate). We recover by relaxing chain verification for the fetch, but
  // it is a real trust/compatibility problem worth reporting.
  tls_chain_incomplete?: boolean;
  scanned_at: string;
  errors?: string[];
  warnings?: string[];
}

export interface SiteLevelData {
  llms_txt?: {
    exists: boolean;
    content?: string;
    fields?: Record<string, string>;
    link_count?: number;
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
  // Observable design signals only. Colours and copyright year were removed
  // because a ScanResult carries no CSS or footer text to derive them honestly.
  fonts: string[];
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
