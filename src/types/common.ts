/**
 * Common type definitions shared across the application
 */

/**
 * Standardized API response format
 */
export interface ApiResponse<T> {
  status: "success" | "error";
  message: string;
  data?: T;
  error?: {
    code: string;
    details?: any;
  };
}

/**
 * Link representation in the system
 */
export interface Link {
  url: string;
  text: string;
  isFollowed: boolean;
  relAttributes: string[];
}

/**
 * Image representation in the system
 */
export interface Image {
  url: string;
  alt?: string;
  dimensions?: {
    width?: number;
    height?: number;
  };
}

/**
 * Common metadata for all database entities
 */
export interface EntityMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Severity levels for issues
 */
export type SeverityLevel = "info" | "low" | "medium" | "high" | "critical";

/**
 * Scan status enum
 */
export type ScanStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * Unified ScanResult interface used throughout the application
 */
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

  // Media
  images: Array<{
    src: string;
    alt: string;
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
  scan_method?: "standard" | "headless";
  scanned_at: string;
  errors?: string[];
  warnings?: string[];
}
