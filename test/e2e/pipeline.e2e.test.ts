import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { AddressInfo } from "net";
import { runScanPipeline } from "../../src/services/scan-pipeline";
import { createProject, createUser, seedScan, svc, cleanup } from "./helpers/db";

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

const pages: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Home</title>
    <meta name="description" content="A small bookkeeping practice homepage."></head>
    <body><h1>Welcome</h1>${BODY}<a href="/about">About</a></body></html>`,
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
});
