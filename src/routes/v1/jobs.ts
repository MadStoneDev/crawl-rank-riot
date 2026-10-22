// /api/v1/jobs — the public jobs API. Authenticated by API key (apiKeyAuth is
// applied by the parent router), scope-checked per route, metered and
// rate-limited per key. A job is a scan: creating one runs the same
// runScanPipeline the rest of the app uses.

import { Router, Response } from "express";
import { getSupabaseServiceClient } from "../../services/database/client";
import { runScanPipeline, ScanMode } from "../../services/scan-pipeline";
import { requestCancel } from "../../services/scan-cancellation";
import { parseProjectSettings } from "../../utils/project-settings";
import { ApiKeyRequest, requireScope } from "../../middleware/api-key-auth";
import { v1Db } from "../../services/api/v1/db";
import { recordUsage, getCurrentUsage } from "../../services/api/v1/usage";
import { sendV1, sendV1Error } from "../../services/api/v1/respond";
import {
  serializeJob,
  serializeReport,
  serializeIssue,
  serializeUsage,
  type JobRow,
  type ScanRowForJob,
} from "../../services/api/v1/serializers";
import type { ScoreReport } from "../../scoring/score-report";

const router = Router();

const SCAN_COLS = "status, started_at, completed_at, pages_scanned, links_scanned, issues_found, failure_reason";

/** Clamp create-job options to safe ranges (mirrors POST /api/scan). */
function clampOptions(type: ScanMode, raw: Record<string, unknown>, projectSettings: { crawlOverrides: Record<string, unknown> }) {
  const n = (v: unknown) => Number(v);
  if (type === "audit") {
    return {
      maxDepth: Math.max(1, Math.min(n(raw?.maxDepth) || 2, 5)),
      maxPages: Math.max(1, Math.min(n(raw?.maxPages) || 50, 500)),
      concurrentRequests: Math.max(1, Math.min(n(raw?.concurrentRequests) || 3, 10)),
      timeout: Math.max(120_000, Math.min(n(raw?.timeout) || 600_000, 3_600_000)),
      checkSitemaps: raw?.checkSitemaps !== false,
      crawlMode: "audit" as const,
      ...projectSettings.crawlOverrides,
    };
  }
  const maxPages = Math.max(1, Math.min(n(raw?.maxPages) || 500, 100000));
  const defaultTimeout = Math.max(300_000, maxPages * 2_000);
  return {
    maxDepth: Math.max(1, Math.min(n(raw?.maxDepth) || 5, 10)),
    maxPages,
    concurrentRequests: Math.max(1, Math.min(n(raw?.concurrentRequests) || 3, 10)),
    timeout: Math.max(300_000, Math.min(n(raw?.timeout) || defaultTimeout, 21_600_000)),
    checkSitemaps: raw?.checkSitemaps !== false,
    crawlMode: "seo" as const,
    ...projectSettings.crawlOverrides,
  };
}

/** Load the job row and confirm it belongs to the calling key. */
async function loadOwnedJob(req: ApiKeyRequest, jobId: string): Promise<JobRow & { scan_id: string | null } | null> {
  const { data } = await v1Db()
    .from("api_jobs")
    .select("id, type, project_id, created_at, scan_id, api_key_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!data || data.api_key_id !== req.apiKey!.id) return null;
  return data as JobRow & { scan_id: string | null };
}

// POST /api/v1/jobs — create a scan job.
router.post("/jobs", requireScope("jobs:write"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const type: ScanMode = req.body?.type === "audit" ? "audit" : "seo";
    const projectId = req.body?.project_id;
    if (!projectId || typeof projectId !== "string") {
      sendV1Error(res, 400, "validation_error", "project_id is required.");
      return;
    }

    const supabase = getSupabaseServiceClient();
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, url, user_id, settings")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError || !project) {
      sendV1Error(res, 404, "project_not_found", "No project with that id.");
      return;
    }
    if (project.user_id !== req.apiKey!.user_id) {
      sendV1Error(res, 403, "forbidden", "This API key's owner does not own that project.");
      return;
    }

    // Monthly job quota (per key).
    const quota = req.apiKey!.monthly_quota;
    if (quota !== null && quota !== undefined) {
      const { usage } = await getCurrentUsage(req.apiKey!.id);
      if (usage.jobs_created >= quota) {
        sendV1Error(res, 429, "quota_exceeded", `Monthly job quota of ${quota} reached for this API key.`, {
          quota,
          jobs_created: usage.jobs_created,
        });
        return;
      }
    }

    // One scan per project at a time (same guard as the app).
    const { data: inProgress } = await supabase
      .from("scans")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "in_progress")
      .limit(1);
    if (inProgress && inProgress.length > 0) {
      sendV1Error(res, 409, "scan_in_progress", "A scan is already running for this project.");
      return;
    }

    const { data: scan, error: scanError } = await supabase
      .from("scans")
      .insert({
        project_id: projectId,
        scan_type: type,
        status: "in_progress",
        started_at: new Date().toISOString(),
        pages_scanned: 0,
        links_scanned: 0,
        issues_found: 0,
        last_progress_update: new Date().toISOString(),
      })
      .select()
      .single();
    if (scanError || !scan) {
      sendV1Error(res, 500, "database_error", "Could not create the scan.");
      return;
    }

    const projectSettings = parseProjectSettings(project.settings, project.url);
    const options = clampOptions(type, req.body?.options ?? {}, projectSettings);

    const { data: job, error: jobError } = await v1Db()
      .from("api_jobs")
      .insert({
        api_key_id: req.apiKey!.id,
        user_id: req.apiKey!.user_id,
        project_id: projectId,
        scan_id: scan.id,
        type,
        request: { options: req.body?.options ?? {} },
      })
      .select("id, type, project_id, created_at")
      .single();
    if (jobError || !job) {
      sendV1Error(res, 500, "database_error", "Could not create the job.");
      return;
    }

    void recordUsage(req.apiKey!.id, { jobs: 1 });

    // Fire-and-forget, exactly like POST /api/scan.
    runScanPipeline(type, project.url, options, scan.id, projectId);

    sendV1(res, 202, serializeJob(job as JobRow, {
      status: "in_progress",
      started_at: scan.started_at,
      completed_at: null,
      pages_scanned: 0,
      links_scanned: 0,
      issues_found: 0,
      failure_reason: null,
    }));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not create the job.");
  }
});

// GET /api/v1/jobs — list this key's jobs (most recent first).
router.get("/jobs", requireScope("jobs:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { data: jobs } = await v1Db()
      .from("api_jobs")
      .select("id, type, project_id, created_at, scan_id")
      .eq("api_key_id", req.apiKey!.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const rows = (jobs ?? []) as Array<JobRow & { scan_id: string | null }>;
    const scanIds = rows.map((j) => j.scan_id).filter((s): s is string => !!s);
    const scanById = new Map<string, ScanRowForJob>();
    if (scanIds.length > 0) {
      const supabase = getSupabaseServiceClient();
      const { data: scans } = await supabase.from("scans").select(`id, ${SCAN_COLS}`).in("id", scanIds);
      for (const s of scans ?? []) scanById.set(s.id as string, s as ScanRowForJob);
    }
    const items = rows.map((j) => serializeJob(j, j.scan_id ? scanById.get(j.scan_id) ?? null : null));
    sendV1(res, 200, { object: "list", items, page: { limit, offset, count: items.length } });
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not list jobs.");
  }
});

// GET /api/v1/jobs/:id — one job's status.
router.get("/jobs/:id", requireScope("jobs:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const job = await loadOwnedJob(req, req.params.id);
    if (!job) {
      sendV1Error(res, 404, "job_not_found", "No job with that id for this API key.");
      return;
    }
    let scan: ScanRowForJob | null = null;
    if (job.scan_id) {
      const supabase = getSupabaseServiceClient();
      const { data } = await supabase.from("scans").select(SCAN_COLS).eq("id", job.scan_id).maybeSingle();
      scan = (data as ScanRowForJob) ?? null;
    }
    sendV1(res, 200, serializeJob(job, scan));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not load the job.");
  }
});

// GET /api/v1/jobs/:id/report — the scored report for a completed job.
router.get("/jobs/:id/report", requireScope("jobs:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const job = await loadOwnedJob(req, req.params.id);
    if (!job || !job.scan_id) {
      sendV1Error(res, 404, "job_not_found", "No job with that id for this API key.");
      return;
    }
    const supabase = getSupabaseServiceClient();
    const { data: scores } = await supabase.from("scan_scores").select("report").eq("scan_id", job.scan_id).maybeSingle();
    const report = scores?.report as ScoreReport | undefined;
    if (!report) {
      sendV1Error(res, 404, "report_not_ready", "No scored report for this job yet. The scan may still be running.");
      return;
    }
    sendV1(res, 200, serializeReport(job.id, report));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not load the report.");
  }
});

// GET /api/v1/jobs/:id/issues — paginated open issues for a job.
router.get("/jobs/:id/issues", requireScope("jobs:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const job = await loadOwnedJob(req, req.params.id);
    if (!job || !job.scan_id) {
      sendV1Error(res, 404, "job_not_found", "No job with that id for this API key.");
      return;
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const supabase = getSupabaseServiceClient();

    const { count } = await supabase
      .from("issues")
      .select("id", { count: "exact", head: true })
      .eq("scan_id", job.scan_id)
      .eq("is_fixed", false)
      .eq("dismissed", false);

    const { data: issueRows } = await supabase
      .from("issues")
      .select("issue_type, severity, description, details, page_id")
      .eq("scan_id", job.scan_id)
      .eq("is_fixed", false)
      .eq("dismissed", false)
      .order("severity", { ascending: true })
      .range(offset, offset + limit - 1);

    const rows = issueRows ?? [];
    const pageIds = rows.map((r) => r.page_id).filter((p): p is string => !!p);
    const urlById = new Map<string, string>();
    if (pageIds.length > 0) {
      const { data: pages } = await supabase.from("pages").select("id, url").in("id", pageIds);
      for (const p of pages ?? []) urlById.set(p.id as string, p.url as string);
    }

    const items = rows.map((r) =>
      serializeIssue({
        issue_type: r.issue_type,
        severity: r.severity,
        description: r.description,
        details: r.details,
        page_url: r.page_id ? urlById.get(r.page_id) ?? null : null,
      }),
    );
    const total = count ?? items.length;
    sendV1(res, 200, {
      object: "list",
      job_id: job.id,
      items,
      page: { limit, offset, total, has_more: offset + items.length < total },
    });
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not load the issues.");
  }
});

// POST /api/v1/jobs/:id/cancel — cancel a running job.
router.post("/jobs/:id/cancel", requireScope("jobs:write"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const job = await loadOwnedJob(req, req.params.id);
    if (!job || !job.scan_id) {
      sendV1Error(res, 404, "job_not_found", "No job with that id for this API key.");
      return;
    }
    requestCancel(job.scan_id);
    const supabase = getSupabaseServiceClient();
    await supabase
      .from("scans")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", job.scan_id)
      .eq("status", "in_progress");
    const { data } = await supabase.from("scans").select(SCAN_COLS).eq("id", job.scan_id).maybeSingle();
    sendV1(res, 200, serializeJob(job, (data as ScanRowForJob) ?? null));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not cancel the job.");
  }
});

export default router;
