import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { Scanner, type ScannerDeps } from "../scanner";
import { techFingerprintModule } from "./modules";
import type { PipelineContext } from "./types";
import type { ScanResult } from "../../types";

/**
 * Regression test for the PC-08 production miss: tech_fingerprint.analytics came
 * back EMPTY for ravenci.solutions via the /api/v1 job API even though the
 * before/after golden test (which calls extractFromHtml directly) detects GA4 +
 * GTM on the same bytes.
 *
 * The divergence was in the crawl path the API actually uses: the HTTP scan
 * (Scanner.httpScan -> processHtml) copied parsed fields onto the ScanResult
 * one by one and never copied `inline_scripts` / `preload_hrefs`, so the
 * tech_fingerprint module — which reads those to spot analytics configured
 * inline or via a preload hint (next/third-parties) — saw nothing. The headless
 * path set them; the HTTP path (the one ravenci takes) silently dropped them.
 *
 * This test runs the REAL path a `scope: "page"` + `tech_fingerprint` API job
 * runs — Scanner.scan() over the captured golden bytes, then the actual
 * techFingerprintModule — and asserts GA/GTM are detected. It does not call
 * runScanPipeline() directly because that wrapper's only extra work here is DB
 * persistence (storeScanResults, the api_job_pages snapshot, the scans
 * finalize) and project scheduling — none of which touch the extract/fingerprint
 * logic this bug lived in. Pinning the crawl + module instead keeps the test
 * deterministic and offline (no Supabase, no puppeteer) while covering the exact
 * code that diverged.
 */

const DIR = join(__dirname, "..", "extract", "__fixtures__", "before-after");
const PAGE_URL = "https://ravenci.solutions/";

/** Rebuild the captured response headers so header-driven logic (platform
 *  detection, content-type decode) behaves exactly as it did in production. */
function fixtureHeaders(): Headers {
  const raw = readFileSync(join(DIR, "nextjs-ravenci-home.headers.txt"), "utf8");
  const headers = new Headers();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^HTTP\//i.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    try {
      headers.set(name, value);
    } catch {
      /* skip any header name the runtime rejects */
    }
  }
  return headers;
}

/**
 * A fetch stand-in matching proxyFetch's shape. The page GET returns the golden
 * bytes + headers; image HEAD probes (fetchImageFileSizes) get a bare 404 so no
 * real network is touched.
 */
function fixtureFetch(): ScannerDeps["fetchImpl"] {
  const body = readFileSync(join(DIR, "nextjs-ravenci-home.html"));
  const headers = fixtureHeaders();
  return (async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method || "GET").toUpperCase() === "HEAD") {
      return new Response(null, { status: 404 });
    }
    return new Response(new Uint8Array(body), { status: 200, headers });
  }) as ScannerDeps["fetchImpl"];
}

/** Minimal PipelineContext — techFingerprintModule only reads scanResults,
 *  pageModules and logger.info, and writes techRollup. */
function makeCtx(scanResults: ScanResult[]): PipelineContext {
  return {
    scanResults,
    pageModules: new Map(),
    logger: { info() {} },
  } as unknown as PipelineContext;
}

describe("v1 tech_fingerprint over the real crawl path (PC-08 regression)", () => {
  it("detects GA4 + GTM on ravenci.solutions via scan() -> techFingerprintModule", async () => {
    const scanner = new Scanner({
      urlGuard: async () => true,
      fetchImpl: fixtureFetch(),
    });

    const result = await scanner.scan(PAGE_URL, 0);

    // Pin the path: this must be the HTTP scan (the one production took and the
    // one the bug was in), never an accidental headless escalation.
    expect(result.scan_method).toBe("http");
    expect(result.status).toBe(200);

    // The fields the HTTP path used to drop. If these are empty the fingerprint
    // can't see inline/preloaded analytics — exactly the production symptom.
    expect((result.inline_scripts ?? []).length).toBeGreaterThan(0);
    expect((result.preload_hrefs ?? []).length).toBeGreaterThan(0);

    // Run the actual pipeline module the job runs.
    const ctx = makeCtx([result]);
    await techFingerprintModule.run(ctx);

    const rollup = ctx.techRollup as { analytics: string[] };
    expect(rollup.analytics).toContain("Google Analytics");
    expect(rollup.analytics).toContain("Google Tag Manager");

    // And it is stashed per-URL for the api_job_pages snapshot.
    const perPage = ctx.pageModules.get(result.url) as
      | { tech_fingerprint?: { analytics: string[] } }
      | undefined;
    expect(perPage?.tech_fingerprint?.analytics).toContain("Google Analytics");
    expect(perPage?.tech_fingerprint?.analytics).toContain("Google Tag Manager");
  });
});
