import { describe, it, expect } from "vitest";
import { computeScoreReport, SCORE_VERSION } from "./score-report";
import { computeSeoScore } from "../utils/seo-score";
import {
  makeScanResult,
  makeOptimizedPage,
} from "../../test/fixtures/scan-result";

describe("computeScoreReport", () => {
  it("stamps the current version", () => {
    expect(computeScoreReport([makeOptimizedPage()]).version).toBe(SCORE_VERSION);
  });

  it("scores a fully-optimized page 100 across every category", () => {
    const report = computeScoreReport([makeOptimizedPage()]);
    expect(report.overall).toBe(100);
    expect(report.categories.technical.score).toBe(100);
    expect(report.categories.content.score).toBe(100);
    expect(report.categories.media.score).toBe(100);
    expect(report.categories.aeo.score).toBe(100);
  });

  it("stays numerically identical to the legacy computeSeoScore adapter", () => {
    // Parity guard: computeSeoScore now delegates here, so a mixed corpus must
    // produce the same four category numbers + overall through both entry points.
    const corpus = [
      makeOptimizedPage(),
      makeScanResult({ status: 200, is_indexable: true }),
      makeOptimizedPage({ load_time_ms: 9000, meta_description: undefined }),
      makeScanResult({ status: 404 }),
    ];
    const report = computeScoreReport(corpus);
    const flat = computeSeoScore(corpus);
    expect(flat).toEqual({
      technical: report.categories.technical.score,
      content: report.categories.content.score,
      media: report.categories.media.score,
      aeo: report.categories.aeo.score,
      overall: report.overall,
    });
  });

  it("records the actual offending URLs on a failing check", () => {
    const good = makeOptimizedPage({ url: "https://site.com/good" });
    const noTitle = makeOptimizedPage({ url: "https://site.com/bad", title: undefined });
    const report = computeScoreReport([good, noTitle]);
    const titleCheck = report.categories.content.checks.find((c) => c.id === "title")!;
    expect(titleCheck.status).toBe("fail");
    expect(titleCheck.passed).toBe(1);
    expect(titleCheck.total).toBe(2);
    expect(titleCheck.affectedUrls).toEqual(["https://site.com/bad"]);
  });

  it("marks a check 'na' (not a pass) when there is nothing to evaluate", () => {
    // No images anywhere -> media check is na, not a fabricated pass.
    const report = computeScoreReport([makeScanResult({ status: 200 })]);
    const imgCheck = report.categories.media.checks.find((c) => c.id === "img_alt")!;
    expect(imgCheck.status).toBe("na");
    expect(imgCheck.total).toBe(0);
  });

  it("produces a per-page score keyed by URL", () => {
    const report = computeScoreReport([
      makeOptimizedPage({ url: "https://site.com/a" }),
      makeScanResult({ url: "https://site.com/b", status: 200 }),
    ]);
    expect(report.pages["https://site.com/a"].score).toBe(100);
    expect(report.pages["https://site.com/b"].score).toBeLessThan(100);
    expect(report.pages["https://site.com/b"].checks.length).toBeGreaterThan(0);
  });

  it("forces 0 and empty checks on a bot-blocked crawl, regardless of content", () => {
    // Even a perfect-looking page cannot inflate a blocked scan.
    const report = computeScoreReport([makeOptimizedPage()], { blocked: true });
    expect(report.blocked).toBe(true);
    expect(report.overall).toBe(0);
    expect(report.categories.technical.score).toBe(0);
    expect(report.pages).toEqual({});
  });

  it("returns all zeros for an empty crawl", () => {
    const report = computeScoreReport([]);
    expect(report.overall).toBe(0);
    expect(report.categories.content.score).toBe(0);
  });
});
