import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, api, type TestServer } from "./helpers/server";
import {
  createUser,
  createProject,
  createApiKey,
  seedScan,
  seedApiJob,
  seedJobPage,
  cleanup,
} from "./helpers/db";

// Stage 4 end-to-end: projects API, the per-job pages endpoints and job
// attribution/scope. Local Supabase only (see helpers/guard.ts) with the Stage
// 4 migration applied locally. Run with `npm run test:e2e`.

let server: TestServer;
let userA: { id: string; email: string };
let userB: { id: string; email: string };

const ALL = ["jobs:read", "jobs:write", "projects:read", "projects:write"] as const;

beforeAll(async () => {
  server = await startTestServer();
  userA = await createUser();
  userB = await createUser();
});

afterAll(async () => {
  await cleanup();
  await server.close();
});

describe("projects API", () => {
  it("creates a project (201), deriving the domain and echoing attribution", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const { status, json } = await api(server.base, "POST", "/api/v1/projects", {
      key: key.raw,
      body: { domain: "https://www.acme-e2e.test/", name: "Acme", external_ref: "crm-1", metadata: { tier: "pro" } },
    });
    expect(status).toBe(201);
    expect(json.data.object).toBe("project");
    expect(json.data.domain).toBe("acme-e2e.test");
    expect(json.data.external_ref).toBe("crm-1");
    expect(json.data.metadata).toEqual({ tier: "pro" });
  });

  it("dedupes by normalised domain per owner (200, same id)", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const first = await api(server.base, "POST", "/api/v1/projects", {
      key: key.raw,
      body: { domain: "dedupe-e2e.test", name: "Dedupe" },
    });
    expect(first.status).toBe(201);
    const second = await api(server.base, "POST", "/api/v1/projects", {
      key: key.raw,
      body: { url: "https://www.dedupe-e2e.test/pricing", name: "Dedupe 2" },
    });
    expect(second.status).toBe(200);
    expect(second.json.data.id).toBe(first.json.data.id);
  });

  it("lists projects and filters by external_ref; reads one by id", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const created = await api(server.base, "POST", "/api/v1/projects", {
      key: key.raw,
      body: { domain: "filter-e2e.test", name: "Filter", external_ref: "find-me" },
    });
    const id = created.json.data.id;

    const filtered = await api(server.base, "GET", "/api/v1/projects?external_ref=find-me", { key: key.raw });
    expect(filtered.status).toBe(200);
    expect(filtered.json.data.items.some((p: any) => p.id === id)).toBe(true);
    expect(filtered.json.data.items.every((p: any) => p.external_ref === "find-me")).toBe(true);

    const one = await api(server.base, "GET", `/api/v1/projects/${id}`, { key: key.raw });
    expect(one.status).toBe(200);
    expect(one.json.data.id).toBe(id);
  });

  it("does not expose another owner's project (404)", async () => {
    const keyA = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const projectB = await createProject(userB.id);
    const { status, json } = await api(server.base, "GET", `/api/v1/projects/${projectB.id}`, { key: keyA.raw });
    expect(status).toBe(404);
    expect(json.error.code).toBe("project_not_found");
  });

  it("enforces project scopes", async () => {
    const readOnly = await createApiKey({ userId: userA.id, scopes: ["projects:read"] });
    const create = await api(server.base, "POST", "/api/v1/projects", {
      key: readOnly.raw,
      body: { domain: "scope-e2e.test", name: "Scope" },
    });
    expect(create.status).toBe(403);
    expect(create.json.error.code).toBe("insufficient_scope");
  });
});

describe("job attribution + scope round-trip", () => {
  it("echoes scope, modules, external_ref and metadata on read", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const project = await createProject(userA.id);
    const create = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: {
        type: "seo",
        project_id: project.id,
        scope: "page",
        modules: ["fetch_extract", "tech_fingerprint"],
        external_ref: "job-ref-9",
        metadata: { source: "e2e" },
      },
    });
    expect(create.status).toBe(202);
    expect(create.json.data.scope).toBe("page");
    expect(create.json.data.modules).toEqual(["fetch_extract", "tech_fingerprint"]);

    const got = await api(server.base, "GET", `/api/v1/jobs/${create.json.data.id}`, { key: key.raw });
    expect(got.json.data.external_ref).toBe("job-ref-9");
    expect(got.json.data.metadata).toEqual({ source: "e2e" });
    expect(got.json.data.links.pages).toContain("/pages");
  });

  it("rejects an off-domain url for page scope (400)", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const project = await createProject(userA.id);
    const { status, json } = await api(server.base, "POST", "/api/v1/jobs", {
      key: key.raw,
      body: { type: "seo", project_id: project.id, scope: "page", url: "https://evil.example/x" },
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe("validation_error");
  });
});

describe("per-job pages endpoints", () => {
  it("lists pages with pagination and serves full detail with gated content", async () => {
    const key = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const project = await createProject(userA.id);
    const scan = await seedScan({ projectId: project.id, status: "completed" });
    const jobId = await seedApiJob({ apiKeyId: key.id, userId: userA.id, projectId: project.id, scanId: scan });
    await seedJobPage({
      jobId,
      url: "https://acme.test/a",
      data: { url: "https://acme.test/a", title: "A", word_count: 100 },
      content: "cleaned body text of A",
      modules: { tech_fingerprint: { platform: "wordpress" }, business_info: { name: "Acme" } },
    });
    await seedJobPage({ jobId, url: "https://acme.test/b", data: { url: "https://acme.test/b", title: "B", word_count: 50 } });

    const list = await api(server.base, "GET", `/api/v1/jobs/${jobId}/pages?limit=1&offset=0`, { key: key.raw });
    expect(list.status).toBe(200);
    expect(list.json.data.object).toBe("list");
    expect(list.json.data.items).toHaveLength(1);
    expect(list.json.data.page.total).toBe(2);
    expect(list.json.data.page.has_more).toBe(true);

    // Detail for the first page (ordered by url → /a).
    const pageId = list.json.data.items[0].id;
    const noContent = await api(server.base, "GET", `/api/v1/jobs/${jobId}/pages/${pageId}`, { key: key.raw });
    expect(noContent.status).toBe(200);
    expect(noContent.json.data.title).toBe("A");
    expect(noContent.json.data.modules.tech_fingerprint).toEqual({ platform: "wordpress" });
    expect("content" in noContent.json.data).toBe(false);

    const withContent = await api(server.base, "GET", `/api/v1/jobs/${jobId}/pages/${pageId}?include=content`, { key: key.raw });
    expect(withContent.json.data.content).toBe("cleaned body text of A");
  });

  it("does not expose another key's job pages (404)", async () => {
    const keyA = await createApiKey({ userId: userA.id, scopes: [...ALL] });
    const keyB = await createApiKey({ userId: userB.id, scopes: [...ALL] });
    const projectB = await createProject(userB.id);
    const scanB = await seedScan({ projectId: projectB.id, status: "completed" });
    const jobB = await seedApiJob({ apiKeyId: keyB.id, userId: userB.id, projectId: projectB.id, scanId: scanB });
    const { status, json } = await api(server.base, "GET", `/api/v1/jobs/${jobB}/pages`, { key: keyA.raw });
    expect(status).toBe(404);
    expect(json.error.code).toBe("job_not_found");
  });
});
