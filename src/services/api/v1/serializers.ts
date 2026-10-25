// Internal domain → v1 DTO mapping. This is the SINGLE place that knows how
// internal types (ScoreReport, issue rows, scan rows) become the public
// contract, so internal refactors never leak into it.

import {
  categoryForIssueType,
  isSpeedIssueType,
  type ScoreCategory,
  type Severity,
} from "../../../scoring/weights";
import type { ScoreReport } from "../../../scoring/score-report";
import type { ScanResult } from "../../../types";
import type {
  V1Job,
  V1JobScope,
  V1JobStatus,
  V1JobType,
  V1Report,
  V1Issue,
  V1CategoryScore,
  V1Deduction,
  V1Usage,
  V1Project,
  V1Page,
  V1PageData,
  V1PageDetail,
  V1PageModules,
} from "./schemas";

/**
 * Public display labels for the four score categories. The API exposes BOTH
 * the machine value (`category`) and this label so Vanward can display them
 * without hardcoding its own mapping. These match the app's Option A labels.
 */
export const CATEGORY_LABELS: Record<ScoreCategory, string> = {
  technical: "Technical",
  content: "Content",
  media: "Media",
  aeo: "AEO",
};

const VALID_SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
function normalizeSeverity(raw: string | null | undefined): Severity {
  const s = (raw || "").toLowerCase();
  return (VALID_SEVERITIES as string[]).includes(s) ? (s as Severity) : "low";
}

/** Map an internal scan status to the public job status. */
export function jobStatusFromScan(scanStatus: string | null | undefined): V1JobStatus {
  switch (scanStatus) {
    case "pending":
      return "queued";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      // No scan row yet (or an unrecognised status): the job is queued.
      return "queued";
  }
}

export interface JobRow {
  id: string;
  type: string;
  project_id: string;
  created_at: string;
  // Stage 4 (optional; absent on pre-Stage-4 rows → sensible defaults).
  scope?: string | null;
  modules?: string[] | null;
  external_ref?: string | null;
  metadata?: Record<string, unknown> | null;
}

const VALID_SCOPES: V1JobScope[] = ["site", "page", "urls"];
function normalizeScope(raw: string | null | undefined): V1JobScope {
  return (VALID_SCOPES as string[]).includes(raw || "") ? (raw as V1JobScope) : "site";
}

export interface ScanRowForJob {
  status: string | null;
  started_at: string | null;
  completed_at: string | null;
  pages_scanned: number | null;
  links_scanned: number | null;
  issues_found: number | null;
  failure_reason: string | null;
}

export function serializeJob(job: JobRow, scan: ScanRowForJob | null): V1Job {
  return {
    object: "job",
    id: job.id,
    type: job.type as V1JobType,
    status: jobStatusFromScan(scan?.status),
    scope: normalizeScope(job.scope),
    modules: job.modules ?? null,
    project_id: job.project_id,
    external_ref: job.external_ref ?? null,
    metadata: job.metadata ?? {},
    created_at: job.created_at,
    started_at: scan?.started_at ?? null,
    completed_at: scan?.completed_at ?? null,
    stats: {
      pages_scanned: scan?.pages_scanned ?? 0,
      links_scanned: scan?.links_scanned ?? 0,
      issues_found: scan?.issues_found ?? 0,
    },
    failure_reason: scan?.failure_reason ?? null,
    links: {
      self: `/api/v1/jobs/${job.id}`,
      report: `/api/v1/jobs/${job.id}/report`,
      issues: `/api/v1/jobs/${job.id}/issues`,
      pages: `/api/v1/jobs/${job.id}/pages`,
    },
  };
}

// --- Projects (Stage 4) ---------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  url: string;
  created_at?: string | null;
}

export function serializeProject(
  project: ProjectRow,
  attrs: { external_ref?: string | null; metadata?: Record<string, unknown> | null } | null,
): V1Project {
  return {
    object: "project",
    id: project.id,
    domain: domainOf(project.url),
    name: project.name,
    url: project.url,
    external_ref: attrs?.external_ref ?? null,
    metadata: attrs?.metadata ?? {},
    created_at: project.created_at ?? "",
  };
}

/**
 * Bare registrable-ish host for display + dedup: lowercased, with scheme, a
 * leading `www.`, any path/query/fragment and a trailing slash all dropped. So
 * `http://www.acme.test/`, `https://acme.test` and `acme.test/x` all normalise
 * to `acme.test` — apex and www are the same site.
 */
export function domainOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return (url || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  }
}

/**
 * True when `url` is on `domain` (the project's `domainOf`): the apex, its
 * `www`, or any subdomain — regardless of scheme or trailing slash. Used to keep
 * page/urls-scope jobs on the project's own site.
 */
export function isSameSite(url: string, domain: string): boolean {
  const host = domainOf(url);
  return !!host && (host === domain || host.endsWith(`.${domain}`));
}

// --- Pages (Stage 4) ------------------------------------------------------

/** Map a crawled page (ScanResult) to the stored/public per-page data blob. */
export function serializePageData(result: ScanResult): V1PageData {
  return {
    url: result.url,
    http_status: result.status ?? null,
    title: result.title ?? null,
    meta_description: result.meta_description ?? null,
    canonical_url: result.canonical_url ?? null,
    is_indexable: result.is_indexable ?? null,
    word_count: result.word_count ?? null,
    content_length: result.content_length ?? null,
    headings: {
      h1: result.h1s ?? [], h2: result.h2s ?? [], h3: result.h3s ?? [],
      h4: result.h4s ?? [], h5: result.h5s ?? [], h6: result.h6s ?? [],
    },
    schema_types: result.schema_types ?? [],
    structured_data: result.structured_data ?? [],
    open_graph: result.open_graph ?? {},
    twitter_card: result.twitter_card ?? {},
    images: result.images ?? [],
    internal_links: result.internal_links ?? [],
    external_links: result.external_links ?? [],
    detected_platform: result.detected_platform ?? null,
    scan_method: result.scan_method ?? null,
  };
}

/** A stored api_job_pages row (shape from the DB; `data` is a V1PageData blob). */
export interface JobPageRow {
  id: string;
  url: string;
  http_status: number | null;
  data: V1PageData | null;
  content?: string | null;
  modules: V1PageModules | null;
}

/** Compact list item. */
export function serializePageListItem(row: JobPageRow): V1Page {
  return {
    object: "page",
    id: row.id,
    url: row.url,
    http_status: row.http_status ?? null,
    title: row.data?.title ?? null,
    word_count: row.data?.word_count ?? null,
    modules: row.modules ?? {},
  };
}

/** Full page detail; `content` included only when requested. */
export function serializePageDetail(row: JobPageRow, includeContent: boolean): V1PageDetail {
  const data = row.data ?? ({} as V1PageData);
  const detail: V1PageDetail = {
    object: "page",
    id: row.id,
    ...data,
    url: row.url,
    http_status: row.http_status ?? data.http_status ?? null,
    modules: row.modules ?? {},
  };
  if (includeContent) detail.content = row.content ?? null;
  return detail;
}

function serializeCategory(
  category: ScoreCategory,
  c: { score: number; passRate: number },
): V1CategoryScore {
  return {
    category,
    label: CATEGORY_LABELS[category],
    score: c.score,
    pass_rate: c.passRate,
  };
}

export function serializeReport(jobId: string, report: ScoreReport): V1Report {
  const deductions: V1Deduction[] = (report.deductions ?? []).map((d) => ({
    issue_type: d.issueType,
    category: d.category,
    label: CATEGORY_LABELS[d.category],
    severity: d.severity,
    is_speed: isSpeedIssueType(d.issueType),
    affected_pages: d.affectedPages,
    scored_pages: d.scoredPages,
    penalty: d.penalty,
    site_level: d.siteLevel,
  }));

  return {
    object: "report",
    job_id: jobId,
    score_version: report.version,
    score_model: report.scoreModel ?? null,
    blocked: report.blocked,
    capped: report.capped ?? null,
    overall: report.overall,
    overall_pass_rate: report.overallPassRate ?? null,
    categories: [
      serializeCategory("technical", report.categories.technical),
      serializeCategory("content", report.categories.content),
      serializeCategory("media", report.categories.media),
      serializeCategory("aeo", report.categories.aeo),
    ],
    deductions,
  };
}

export interface IssueRow {
  issue_type: string;
  severity: string | null;
  description: string | null;
  details?: unknown;
  page_url?: string | null;
}

export function serializeIssue(row: IssueRow): V1Issue {
  const category = categoryForIssueType(row.issue_type);
  return {
    object: "issue",
    type: row.issue_type,
    category,
    category_label: CATEGORY_LABELS[category],
    severity: normalizeSeverity(row.severity),
    is_speed: isSpeedIssueType(row.issue_type),
    page_url: row.page_url ?? null,
    description: row.description ?? null,
    ...(row.details !== undefined ? { details: row.details } : {}),
  };
}

export function serializeUsage(
  periodStart: string,
  requests: number,
  jobsCreated: number,
  quota: number | null,
): V1Usage {
  return {
    object: "usage",
    period: "month",
    period_start: periodStart,
    requests,
    jobs_created: jobsCreated,
    quota,
    quota_remaining: quota === null ? null : Math.max(0, quota - jobsCreated),
  };
}
