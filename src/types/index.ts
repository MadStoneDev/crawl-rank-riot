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

export interface Project {
  id: string;
  name: string;
  url: string;
  user_id: string;
  created_at: string;
  last_scan_at?: string;
  scan_frequency?: "weekly" | "monthly";
}
