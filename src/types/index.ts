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
  }>;

  // Technical information
  redirect_url: string | null;
  is_redirect?: boolean;
  redirected_from?: string;
  content_type: string;
  size_bytes: number;
  load_time_ms: number;
  first_byte_time_ms: number;

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

  // Crawler metadata
  scan_method?: "http" | "headless";
  scanned_at: string;
  errors?: string[];
  warnings?: string[];
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
