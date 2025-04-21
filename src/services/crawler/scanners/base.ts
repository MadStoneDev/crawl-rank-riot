import { ScanResult } from "../../../types/common";

/**
 * Base scanner options
 */
export interface ScannerOptions {
  userAgent?: string;
  timeout?: number;
}

/**
 * Base scanner interface for all scanner implementations
 */
export interface Scanner {
  /**
   * Scans a URL and returns details about the page
   * @param url URL to scan
   * @param depth Current crawl depth
   * @returns Scan result
   */
  scan(url: string, depth: number): Promise<ScanResult>;
}

/**
 * Base scanner abstract class that provides common functionality
 */
export abstract class BaseScanner implements Scanner {
  protected readonly userAgent: string;
  protected readonly timeout: number;

  /**
   * Creates a new base scanner
   * @param options Scanner options
   */
  constructor(options: ScannerOptions = {}) {
    this.userAgent = options.userAgent || "RankRiot/1.0 SEO Crawler";
    this.timeout = options.timeout || 30000; // 30 seconds default timeout
  }

  /**
   * Abstract scan method to be implemented by scanner implementations
   * @param url URL to scan
   * @param depth Current crawl depth
   */
  abstract scan(url: string, depth: number): Promise<ScanResult>;

  /**
   * Creates a base scan result with default values
   * @param url URL being scanned
   * @param depth Crawl depth
   * @returns Basic scan result
   */
  protected createBaseScanResult(url: string, depth: number): ScanResult {
    return {
      url,
      status: 0,
      depth,
      internal_links: [],
      external_links: [],
      images: [],
      h1s: [],
      h2s: [],
      h3s: [],
      h4s: [],
      h5s: [],
      h6s: [],
      content_length: 0,
      word_count: 0,
      open_graph: {},
      twitter_card: {},
      canonical_url: null,
      is_indexable: true,
      has_robots_noindex: false,
      has_robots_nofollow: false,
      redirect_url: null,
      content_type: "",
      size_bytes: 0,
      load_time_ms: 0,
      first_byte_time_ms: 0,
      structured_data: [],
      schema_types: [],
      js_count: 0,
      css_count: 0,
      keywords: [],
      scanned_at: new Date().toISOString(),
      errors: [],
      warnings: [],
    };
  }

  /**
   * Handles errors during scanning
   * @param url URL that was being scanned
   * @param depth Crawl depth
   * @param error Error that occurred
   * @returns Error scan result
   */
  protected handleScanError(
    url: string,
    depth: number,
    error: unknown,
  ): ScanResult {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const result = this.createBaseScanResult(url, depth);
    result.errors = [`Scan failed: ${errorMessage}`];

    return result;
  }
}
