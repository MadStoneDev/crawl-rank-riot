// Versioned response DTOs for the public /api/v1 jobs API (Stage 3).
//
// These are the ONLY shapes the public API emits. They are intentionally
// decoupled from the internal domain types (ScanResult, ScoreReport, DB rows)
// so internal refactors never leak into the contract. The serializers
// (serializers.ts) are the single place that maps internal → DTO.

import type { ScoreCategory, Severity } from "../../../scoring/weights";

/** Every v1 response is wrapped in this envelope. */
export interface V1Envelope<T> {
  api_version: string; // "v1"
  schema_version: string; // e.g. "1.0.0"
  data: T;
}

/** Error body (also wrapped by the envelope's siblings at the top level). */
export interface V1Error {
  api_version: string;
  schema_version: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type V1JobType = "seo" | "audit";
export type V1JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** A scan exposed as an API job. */
export interface V1Job {
  object: "job";
  id: string;
  type: V1JobType;
  status: V1JobStatus;
  project_id: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Headline counts; populated as the scan progresses/completes. */
  stats: {
    pages_scanned: number;
    links_scanned: number;
    issues_found: number;
  };
  /** Why a job failed, when status is "failed". */
  failure_reason?: string | null;
  /** Relative API paths for the job's sub-resources. */
  links: {
    self: string;
    report: string;
    issues: string;
  };
}

/** One scored category in a report. */
export interface V1CategoryScore {
  category: ScoreCategory; // machine value: technical|content|media|aeo
  label: string; // display label: Technical|Content|Media|AEO
  score: number; // 0-100 health
  pass_rate: number; // 0-100 check pass rate (a distinct axis)
}

/** One deduction behind the overall score. */
export interface V1Deduction {
  issue_type: string;
  category: ScoreCategory;
  label: string;
  severity: Severity;
  is_speed: boolean;
  affected_pages: number;
  scored_pages: number;
  penalty: number;
  site_level: boolean;
}

/** The scored report for a completed job. */
export interface V1Report {
  object: "report";
  job_id: string;
  score_version: number;
  score_model: string | null;
  blocked: boolean;
  capped: "critical" | "high" | null;
  overall: number;
  overall_pass_rate: number | null;
  categories: V1CategoryScore[];
  deductions: V1Deduction[];
}

/** One issue in a job's issue list. */
export interface V1Issue {
  object: "issue";
  type: string; // crawler issue_type, e.g. "missing_image_alt"
  category: ScoreCategory; // technical|content|media|aeo
  category_label: string; // Technical|Content|Media|AEO
  severity: Severity; // from the issues table (the source of truth, F-D10)
  is_speed: boolean; // cross-category speed tag (F-D09)
  page_url: string | null; // null for site-level issues
  description: string | null;
  details?: unknown;
}

/** A page of issues. */
export interface V1IssueList {
  object: "list";
  job_id: string;
  items: V1Issue[];
  page: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
  };
}

/** Per-key usage for the current calendar month (UTC). */
export interface V1Usage {
  object: "usage";
  period: "month";
  period_start: string; // YYYY-MM-01
  requests: number;
  jobs_created: number;
  quota: number | null; // monthly job quota, null = unlimited
  quota_remaining: number | null;
}
