import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, api, type TestServer } from "./helpers/server";
import {
  createUser,
  createProject,
  createApiKey,
  seedScan,
  seedApiJob,
  seedPage,
  seedIssue,
  seedScanScores,
  bumpUsage,
  scanStatus,
  cleanup,
} from "./helpers/db";

// End-to-end tests for the public /api/v1 jobs API against a LOCAL Supabase.
// Gated to localhost by test/e2e/helpers/guard.ts. Run with `npm run test:e2e`.

let server: TestServer;
let userA: { id: string; email: string };
let userB: { id: string; email: string };

beforeAll(async () => {
  server = await startTestServer();
  userA = await createUser();
  userB = await createUser();
});

afterAll(async () => {
  await cleanup();
  await server.close();
});

describe("public endpoints (no key)", () => {
  it("GET /health is open", async () => {
    const { status, json } = await api(server.base, "GET", "/api/v1/health");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.api_version).toBe("v1");
  });

  it("GET /meta lists versions, scopes and endpoints", async () => {
    const { status, json } = await api(server.base, "GET", "/api/v1/meta");
    expect(status).toBe(200);
    expect(json.api_version).toBe("v1");
    expect(json.data.scopes).toEqual(expect.arrayContaining(["jobs:read", "jobs:write"]));
    expect(json.data.endpoints.length).toBeGreaterThan(0);
  });
});

describe("authentication", () => {
  it("rejects a request with no key (401 invalid_api_key)", async () => {
    const { status, json } = await api(server.base, "GET", "/api/v1/usage");
    expect(status).toBe(401);
    expect(json.error.code).toBe("invalid_api_key");
  });

  it("rejects an unrecognised key (401 invalid_api_key)", async () => {
    const { status, json } = await api(server.base, "GET", "/api/v1/usage", {
      key: "rrk_test_not-a-real-key-000000000000000000000000",
    });
    expect(status).toBe(401);
    expect(json.error.code).toBe("invalid_api_key");
  });

  it("accepts a valid key via Authorization: Bearer", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"] });
    const { status, json } = await api(server.base, "GET", "/api/v1/usage", { key: key.raw });
    expect(status).toBe(200);
    expect(json.data.object).toBe("usage");
  });

  it("accepts a valid key via the X-API-Key header", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"] });
    const { status } = await api(server.base, "GET", "/api/v1/usage", {
      key: key.raw,
      headerName: "X-API-Key",
    });
    expect(status).toBe(200);
  });

  it("rejects a revoked key (401 key_revoked)", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"], status: "revoked" });
    const { status, json } = await api(server.base, "GET", "/api/v1/usage", { key: key.raw });
    expect(status).toBe(401);
    expect(json.error.code).toBe("key_revoked");
  });
});

describe("scopes", () => {
  it("a jobs:read-only key cannot create jobs (403 insufficient_scope)", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"] });
    const project = await createProject(userA.id);
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo", project_id: project.id },
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe("insufficient_scope");
    expect(json.error.details.required_scope).toBe("jobs:write");
  });

  it("a jobs:write-only key cannot list jobs (403 insufficient_scope)", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:write"] });
    const { status, json } = await api(server.base, "GET", "/api/v1/jobs", { key: key.raw });
    expect(status).toBe(403);
    expect(json.error.code).toBe("insufficient_scope");
  });
});

describe("rate limiting", () => {
  it("returns 429 rate_limited once a key's per-minute limit is exceeded", async () => {
    const key = await createApiKey({
      userId: userA.id,
      scopes: ["jobs:read"],
      rateLimitPerMin: 2,
    });
    const first = await api(server.base, "GET", "/api/v1/usage", { key: key.raw });
    const second = await api(server.base, "GET", "/api/v1/usage", { key: key.raw });
    const third = await api(server.base, "GET", "/api/v1/usage", { key: key.raw });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe("rate_limited");
  });
});

describe("monthly job quota", () => {
  it("returns 429 quota_exceeded when the month's job quota is reached", async () => {
    const key = await createApiKey({
      userId: userA.id,
      scopes: ["jobs:write"],
      monthlyQuota: 1,
    });
    const project = await createProject(userA.id);
    // Put month-to-date jobs_created at the quota so the next create is over.
    await bumpUsage(key.id, 0, 1);
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo", project_id: project.id },
    });
    expect(status).toBe(429);
    expect(json.error.code).toBe("quota_exceeded");
  });
});

describe("create validation & ownership", () => {
  it("400 validation_error when project_id is missing", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:write"] });
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo" },
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("validation_error");
  });

  it("404 project_not_found for an unknown project", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:write"] });
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo", project_id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("project_not_found");
  });

  it("403 forbidden when the key's owner does not own the project (cross-account)", async () => {
    const keyA = await createApiKey({ userId: userA.id, scopes: ["jobs:write"] });
    const projectB = await createProject(userB.id);
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: keyA.raw,
      body: { type: "seo", project_id: projectB.id },
    });
    expect(status).toBe(403);
    expect(json.error.code).toBe("forbidden");
  });

  it("409 scan_in_progress when the project already has a running scan", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:write"] });
    const project = await createProject(userA.id);
    await seedScan({ projectId: project.id, status: "in_progress" });
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo", project_id: project.id },
    });
    expect(status).toBe(409);
    expect(json.error.code).toBe("scan_in_progress");
  });
});

describe("cross-account read isolation", () => {
  it("404 job_not_found when reading a job owned by another key", async () => {
    const keyA = await createApiKey({ userId: userA.id, scopes: ["jobs:read", "jobs:write"] });
    const keyB = await createApiKey({ userId: userB.id, scopes: ["jobs:read", "jobs:write"] });
    const projectB = await createProject(userB.id);
    const scanB = await seedScan({ projectId: projectB.id, status: "completed" });
    const jobB = await seedApiJob({
      apiKeyId: keyB.id,
      userId: userB.id,
      projectId: projectB.id,
      scanId: scanB,
    });
    const { status, json } = await api(server.base, "GET", `/api/v1/jobs/${jobB}`, { key: keyA.raw });
    expect(status).toBe(404);
    expect(json.error.code).toBe("job_not_found");
  });
});

describe("job lifecycle: create → poll → report → issues → cancel", () => {
  it("creates a job (202 running) and the job is pollable", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read", "jobs:write"] });
    const project = await createProject(userA.id);

    const create = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo", project_id: project.id },
    });
    expect(create.status).toBe(202);
    expect(create.json.data.object).toBe("job");
    expect(create.json.data.status).toBe("running");
    expect(create.json.data.links.report).toContain("/report");

    const jobId = create.json.data.id;
    const poll = await api(server.base, "GET", `/api/v1/jobs/${jobId}`, { key: key.raw });
    expect(poll.status).toBe(200);
    expect(poll.json.data.id).toBe(jobId);
    // The loopback crawl fails fast under the strict SSRF guard, so the status
    // is either still running or already a terminal state — never missing.
    expect(["running", "failed", "completed", "cancelled"]).toContain(poll.json.data.status);
  });

  it("returns a scored report for a completed job", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"] });
    const project = await createProject(userA.id);
    const scan = await seedScan({ projectId: project.id, status: "completed", pagesScanned: 3 });
    await seedScanScores(scan, project.id);
    const jobId = await seedApiJob({
      apiKeyId: key.id,
      userId: userA.id,
      projectId: project.id,
      scanId: scan,
    });

    const { status, json } = await api(server.base, "GET", `/api/v1/jobs/${jobId}/report`, {
      key: key.raw,
    });
    expect(status).toBe(200);
    expect(json.data.object).toBe("report");
    expect(json.data.categories).toHaveLength(4);
    expect(json.data.categories.map((c: any) => c.category).sort()).toEqual([
      "aeo",
      "content",
      "media",
      "technical",
    ]);
    for (const c of json.data.categories) {
      expect(typeof c.label).toBe("string");
      expect(typeof c.score).toBe("number");
    }
  });

  it("404 report_not_ready before a scan has scores", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"] });
    const project = await createProject(userA.id);
    const scan = await seedScan({ projectId: project.id, status: "in_progress" });
    const jobId = await seedApiJob({
      apiKeyId: key.id,
      userId: userA.id,
      projectId: project.id,
      scanId: scan,
    });
    const { status, json } = await api(server.base, "GET", `/api/v1/jobs/${jobId}/report`, {
      key: key.raw,
    });
    expect(status).toBe(404);
    expect(json.error.code).toBe("report_not_ready");
  });

  it("paginates issues and exposes category / severity / is_speed", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read"] });
    const project = await createProject(userA.id);
    const scan = await seedScan({ projectId: project.id, status: "completed" });
    const jobId = await seedApiJob({
      apiKeyId: key.id,
      userId: userA.id,
      projectId: project.id,
      scanId: scan,
    });
    const page1 = await seedPage(project.id, "https://example.com/a");
    const page2 = await seedPage(project.id, "https://example.com/b");
    // severity ascending ordering is deterministic; one speed issue to assert the tag.
    await seedIssue({ projectId: project.id, scanId: scan, pageId: page1, issueType: "missing_meta_description", severity: "high", description: "no meta" });
    await seedIssue({ projectId: project.id, scanId: scan, pageId: page1, issueType: "thin_content", severity: "medium", description: "thin" });
    await seedIssue({ projectId: project.id, scanId: scan, pageId: page2, issueType: "slow_page", severity: "high", description: "slow" });

    const first = await api(server.base, "GET", `/api/v1/jobs/${jobId}/issues?limit=2&offset=0`, { key: key.raw });
    expect(first.status).toBe(200);
    expect(first.json.data.object).toBe("list");
    expect(first.json.data.items).toHaveLength(2);
    expect(first.json.data.page.total).toBe(3);
    expect(first.json.data.page.has_more).toBe(true);
    for (const item of first.json.data.items) {
      expect(["technical", "content", "media", "aeo"]).toContain(item.category);
      expect(typeof item.category_label).toBe("string");
      expect(["critical", "high", "medium", "low"]).toContain(item.severity);
      expect(typeof item.is_speed).toBe("boolean");
      expect(item.page_url).toMatch(/^https:\/\/example\.com\//);
    }

    const second = await api(server.base, "GET", `/api/v1/jobs/${jobId}/issues?limit=2&offset=2`, { key: key.raw });
    expect(second.status).toBe(200);
    expect(second.json.data.items).toHaveLength(1);
    expect(second.json.data.page.has_more).toBe(false);

    // The speed tag must appear on slow_page across both pages.
    const all = [...first.json.data.items, ...second.json.data.items];
    const slow = all.find((i: any) => i.type === "slow_page");
    expect(slow?.is_speed).toBe(true);
  });

  it("cancels a running job (200 cancelled) and the scan is marked cancelled", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: ["jobs:read", "jobs:write"] });
    const project = await createProject(userA.id);
    const scan = await seedScan({ projectId: project.id, status: "in_progress" });
    const jobId = await seedApiJob({
      apiKeyId: key.id,
      userId: userA.id,
      projectId: project.id,
      scanId: scan,
    });

    const { status, json } = await api(server.base, "POST", `/api/v1/jobs/${jobId}/cancel`, {
      key: key.raw,
    });
    expect(status).toBe(200);
    expect(json.data.status).toBe("cancelled");
    expect(await scanStatus(scan)).toBe("cancelled");
  });
});
