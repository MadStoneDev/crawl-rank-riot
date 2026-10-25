import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { runScanPipeline } from "../../src/services/scan-pipeline";
import {
  createProject,
  createUser,
  createApiKey,
  seedScan,
  seedApiJob,
  jobPagesCount,
  getJobPage,
  svc,
  cleanup,
} from "./helpers/db";

// Drives the REAL runScanPipeline end to end against a local fixture site, using
// the Scanner's test-only DI seam (a guard that permits 127.0.0.1). This proves
// the whole pipeline — crawl → store → issue detection → scoring → persist —
// works against a locally served site without any production SSRF relaxation
// and without touching the public internet. Gated to a local Supabase.

let fixture: http.Server;
let base: string;

const BODY =
  "<p>This bookkeeping practice helps small businesses keep their accounts " +
  "accurate, file on time, and understand their numbers. We reconcile bank feeds, " +
  "prepare activity statements, and advise on cash flow every month.</p>";

const LOCAL_BUSINESS_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Acme Bookkeeping",
  telephone: "+61 2 1234 5678",
  address: { "@type": "PostalAddress", streetAddress: "1 Main St", addressLocality: "Sydney" },
  sameAs: ["https://facebook.com/acme"],
});

const pages: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Home</title>
    <meta name="description" content="A small bookkeeping practice homepage.">
    <script src="https://www.googletagmanager.com/gtag/js?id=G-XX"></script>
    <script type="application/ld+json">${LOCAL_BUSINESS_LD}</script></head>
    <body><h1>Welcome</h1>${BODY}
    <a href="/about">About</a>
    <a href="tel:+61212345678">Call</a>
    <a href="https://facebook.com/acme">Facebook</a></body></html>`,
  "/about": `<!doctype html><html><head><title>About</title></head>
    <body><h1>About us</h1>${BODY}</body></html>`,
};

beforeAll(async () => {
  fixture = http.createServer((req, res) => {
    const body = pages[req.url ?? ""];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<title>Not found</title>");
      return;
    }
    const buf = Buffer.from(body, "utf-8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(buf.byteLength) });
    res.end(buf);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});

/** Guard that permits ONLY 127.0.0.1 — everything else still hits the real guard. */
const loopbackGuard = async (url: string): Promise<boolean> => {
  try {
    return new URL(url).hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

describe("runScanPipeline against a local fixture (injected guard)", () => {
  it("crawls, scores and persists a completed scan", async () => {
    const user = await createUser();
    const project = await createProject(user.id, { url: base });
    const scanId = await seedScan({ projectId: project.id, status: "in_progress" });

    await runScanPipeline(
      "seo",
      base,
      { maxDepth: 1, maxPages: 5, concurrentRequests: 1, timeout: 30_000, checkSitemaps: false, crawlMode: "seo" },
      scanId,
      project.id,
      { urlGuard: loopbackGuard },
    );

    // Scan finished cleanly.
    const { data: scan } = await svc()
      .from("scans")
      .select("status, pages_scanned")
      .eq("id", scanId)
      .single();
    expect(scan?.status).toBe("completed");
    expect((scan?.pages_scanned ?? 0)).toBeGreaterThanOrEqual(1);

    // Pages were stored for the project.
    const { count: pageCount } = await svc()
      .from("pages")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project.id);
    expect(pageCount ?? 0).toBeGreaterThanOrEqual(1);

    // A scored report was persisted with a numeric overall.
    const { data: scores } = await svc()
      .from("scan_scores")
      .select("overall, report")
      .eq("scan_id", scanId)
      .single();
    expect(scores).toBeTruthy();
    expect(typeof scores?.overall).toBe("number");
  });

  it("runs a modules extraction job (no scoring) and writes a per-job page snapshot", async () => {
    const user = await createUser();
    const project = await createProject(user.id, { url: base });
    const scanId = await seedScan({ projectId: project.id, status: "in_progress" });
    const key = await createApiKey({ userId: user.id, scopes: ["jobs:read", "jobs:write"] });
    const jobId = await seedApiJob({ apiKeyId: key.id, userId: user.id, projectId: project.id, scanId });

    await runScanPipeline(
      "seo",
      base,
      { maxDepth: 0, maxPages: 1, concurrentRequests: 1, timeout: 30_000, checkSitemaps: false, crawlMode: "seo" },
      scanId,
      project.id,
      { urlGuard: loopbackGuard },
      { id: jobId, modules: ["fetch_extract", "tech_fingerprint", "business_info"] },
    );

    // The scan completed and the per-job snapshot captured the home page.
    const { data: scanRow } = await svc().from("scans").select("status").eq("id", scanId).single();
    expect(scanRow?.status).toBe("completed");
    expect(await jobPagesCount(jobId)).toBeGreaterThanOrEqual(1);

    const home = await getJobPage(jobId, `${base}/`);
    expect(home).toBeTruthy();
    const modules = home!.modules as any;
    expect(modules.tech_fingerprint.analytics).toContain("Google Analytics");
    expect(modules.business_info.name).toBe("Acme Bookkeeping");
    expect(modules.business_info.phones).toContain("+61 2 1234 5678");
    expect(typeof home!.content).toBe("string");

    // A pure extraction job (no "scoring" module) writes no scored report.
    const { data: scores } = await svc().from("scan_scores").select("scan_id").eq("scan_id", scanId).maybeSingle();
    expect(scores).toBeNull();
  });
});
