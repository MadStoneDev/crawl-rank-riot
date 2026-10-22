import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/database.types";
import { generateApiKey, type ApiScope } from "../../../src/services/api/v1/keys";
import { computeScoreReport } from "../../../src/scoring/score-report";
import { assertLocalSupabase } from "./guard";

// Service-role client pointed at the LOCAL Supabase (guarded). Lazy so importing
// this module has no side effects during test collection.
let client: SupabaseClient<Database> | null = null;
export function svc(): SupabaseClient<Database> {
  if (!client) {
    const { url, serviceKey } = assertLocalSupabase();
    client = createClient<Database>(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

// Everything we create, torn down in reverse dependency order by cleanup().
const created = {
  issues: [] as string[],
  scanScores: [] as string[],
  apiJobs: [] as string[],
  pages: [] as string[],
  scans: [] as string[],
  apiKeys: [] as string[],
  projects: [] as string[],
  users: [] as string[],
};

let counter = 0;
const uniq = () => `${Date.now()}_${counter++}`;

export async function createUser(): Promise<{ id: string; email: string }> {
  const email = `e2e+${uniq()}@rankriot.test`;
  const { data, error } = await svc().auth.admin.createUser({
    email,
    password: "e2e-password-123!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  created.users.push(data.user.id);
  return { id: data.user.id, email };
}

export async function createProject(
  userId: string,
  overrides: Partial<Database["public"]["Tables"]["projects"]["Insert"]> = {},
): Promise<{ id: string; url: string }> {
  const { data, error } = await svc()
    .from("projects")
    .insert({
      user_id: userId,
      name: `e2e project ${uniq()}`,
      // Loopback by default: the production SSRF guard refuses it, so a job's
      // fire-and-forget crawl fails fast instead of hitting the public internet.
      url: "http://127.0.0.1:9/",
      ...overrides,
    })
    .select("id, url")
    .single();
  if (error || !data) throw new Error(`createProject failed: ${error?.message}`);
  created.projects.push(data.id);
  return { id: data.id, url: data.url };
}

export async function createApiKey(opts: {
  userId: string;
  scopes: ApiScope[];
  rateLimitPerMin?: number;
  monthlyQuota?: number | null;
  status?: "active" | "revoked";
}): Promise<{ id: string; raw: string }> {
  const { key, prefix, hash } = generateApiKey("test");
  const { data, error } = await svc()
    .from("api_keys")
    .insert({
      user_id: opts.userId,
      name: `e2e key ${uniq()}`,
      key_prefix: prefix,
      key_hash: hash,
      scopes: opts.scopes,
      rate_limit_per_min: opts.rateLimitPerMin ?? 1000,
      monthly_quota: opts.monthlyQuota ?? null,
      status: opts.status ?? "active",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`createApiKey failed: ${error?.message}`);
  created.apiKeys.push(data.id);
  return { id: data.id, raw: key };
}

export async function seedScan(opts: {
  projectId: string;
  status: string;
  type?: string;
  pagesScanned?: number;
  linksScanned?: number;
  issuesFound?: number;
  failureReason?: string | null;
}): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await svc()
    .from("scans")
    .insert({
      project_id: opts.projectId,
      status: opts.status,
      scan_type: opts.type ?? "seo",
      started_at: now,
      completed_at: opts.status === "completed" ? now : null,
      pages_scanned: opts.pagesScanned ?? 0,
      links_scanned: opts.linksScanned ?? 0,
      issues_found: opts.issuesFound ?? 0,
      failure_reason: opts.failureReason ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedScan failed: ${error?.message}`);
  created.scans.push(data.id);
  return data.id;
}

export async function seedApiJob(opts: {
  apiKeyId: string;
  userId: string;
  projectId: string;
  scanId: string | null;
  type?: string;
}): Promise<string> {
  const { data, error } = await svc()
    .from("api_jobs")
    .insert({
      api_key_id: opts.apiKeyId,
      user_id: opts.userId,
      project_id: opts.projectId,
      scan_id: opts.scanId,
      type: opts.type ?? "seo",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedApiJob failed: ${error?.message}`);
  created.apiJobs.push(data.id);
  return data.id;
}

export async function seedPage(projectId: string, url: string): Promise<string> {
  const { data, error } = await svc()
    .from("pages")
    .insert({ project_id: projectId, url })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedPage failed: ${error?.message}`);
  created.pages.push(data.id);
  return data.id;
}

export async function seedIssue(opts: {
  projectId: string;
  scanId: string;
  pageId: string;
  issueType: string;
  severity: string;
  description: string;
}): Promise<string> {
  const { data, error } = await svc()
    .from("issues")
    .insert({
      project_id: opts.projectId,
      scan_id: opts.scanId,
      page_id: opts.pageId,
      issue_type: opts.issueType,
      severity: opts.severity,
      description: opts.description,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedIssue failed: ${error?.message}`);
  created.issues.push(data.id);
  return data.id;
}

/** A real, persisted ScoreReport so GET /report returns the live serializer shape. */
export async function seedScanScores(scanId: string, projectId: string): Promise<void> {
  const report = computeScoreReport([], { blocked: false });
  const { data, error } = await svc()
    .from("scan_scores")
    .insert({
      scan_id: scanId,
      project_id: projectId,
      version: report.version,
      overall: report.overall,
      technical: report.categories.technical.score,
      content: report.categories.content.score,
      media: report.categories.media.score,
      aeo: report.categories.aeo.score,
      blocked: report.blocked,
      report: JSON.parse(JSON.stringify(report)),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedScanScores failed: ${error?.message}`);
  created.scanScores.push(data.id);
}

/** Read a scan's status directly (for asserting cancel / background effects). */
export async function scanStatus(scanId: string): Promise<string | null> {
  const { data } = await svc().from("scans").select("status").eq("id", scanId).maybeSingle();
  return data?.status ?? null;
}

/** Bump a key's month-to-date usage (for the quota test) via the real RPC. */
export async function bumpUsage(apiKeyId: string, requests: number, jobs: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const { error } = await svc().rpc("increment_api_key_usage", {
    p_api_key_id: apiKeyId,
    p_day: day,
    p_requests: requests,
    p_jobs: jobs,
  });
  if (error) throw new Error(`bumpUsage failed: ${error.message}`);
}

export async function cleanup(): Promise<void> {
  const s = svc();
  // Delete every child row for our projects by project_id — this also sweeps up
  // rows the API itself created (e.g. a scan started by POST /jobs), not just
  // what the seed helpers inserted.
  for (const pid of created.projects) {
    await s.from("issues").delete().eq("project_id", pid);
    await s.from("scan_scores").delete().eq("project_id", pid);
    await s.from("api_jobs").delete().eq("project_id", pid);
    await s.from("pages").delete().eq("project_id", pid);
    await s.from("scans").delete().eq("project_id", pid);
  }
  for (const kid of created.apiKeys) {
    await s.from("api_key_usage").delete().eq("api_key_id", kid);
    await s.from("api_jobs").delete().eq("api_key_id", kid);
  }
  if (created.apiKeys.length) await s.from("api_keys").delete().in("id", created.apiKeys);
  if (created.projects.length) await s.from("projects").delete().in("id", created.projects);
  for (const id of created.users) {
    await s.auth.admin.deleteUser(id).catch(() => {});
  }
  for (const k of Object.keys(created) as Array<keyof typeof created>) created[k] = [];
}
