import { Database } from "../database.types";

// Export convenient type aliases
export type Project = Database["public"]["Tables"]["projects"]["Row"];
export type Scan = Database["public"]["Tables"]["scans"]["Row"];
export type Page = Database["public"]["Tables"]["pages"]["Row"];
export type PageLink = Database["public"]["Tables"]["page_links"]["Row"];
export type Issue = Database["public"]["Tables"]["issues"]["Row"];
export type ScanPageSnapshot =
  Database["public"]["Tables"]["scan_page_snapshots"]["Row"];

// Custom types for crawler
export interface CrawlOptions {
  concurrency?: number;
  delay?: number;
  timeout?: number;
  maxPages?: number;
  respectRobotsTxt?: boolean;
}

export interface QueueItem {
  url: string;
  depth: number;
  referrer?: string;
  priority?: number;
}

export interface PageData {
  url: string;
  title: string | null;
  h1s: string[] | null;
  h2s: string[] | null;
  h3s: string[] | null;
  meta_description: string | null;
  canonical_url: string | null;
  http_status: number | null;
  content_type: string | null;
  content_length: number | null;
  is_indexable: boolean;
  has_robots_noindex: boolean;
  has_robots_nofollow: boolean;
  redirect_url: string | null;
  load_time_ms: number | null;
  first_byte_time_ms: number | null;
  size_bytes: number | null;
  image_count: number | null;
  js_count: number | null;
  css_count: number | null;
  open_graph: any | null;
  twitter_card: any | null;
  structured_data: any | null;
  links: LinkData[];
  issues: IssueData[];
}

export interface LinkData {
  destination_url: string;
  anchor_text: string | null;
  link_type: "internal" | "external" | "resource";
  is_followed: boolean;
}

export interface IssueData {
  issue_type: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  details?: any;
}

// You can copy the database.ts file content directly from the paste you shared
