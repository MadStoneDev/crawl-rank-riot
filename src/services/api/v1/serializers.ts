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
import type {
  V1Job,
  V1JobStatus,
  V1JobType,
  V1Report,
  V1Issue,
  V1CategoryScore,
  V1Deduction,
  V1Usage,
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
    project_id: job.project_id,
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
    },
  };
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
