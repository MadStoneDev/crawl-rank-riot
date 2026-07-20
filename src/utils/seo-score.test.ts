import { describe, it, expect } from "vitest";
import { computeSeoScore } from "./seo-score";
import {
  makeScanResult,
  makeOptimizedPage,
} from "../../test/fixtures/scan-result";

/**
 * CHARACTERIZATION TESTS — these pin the CURRENT behavior of the canonical
 * scorer, including behaviors we already know are wrong and intend to change in
 * Phase 1 of the master plan (see RANKRIOT_MASTER_PLAN.md):
 *   - `media === 100` when a page has no images (flattering neutral default)
 *   - the fast/slow split keys off `load_time_ms`, which today measures
 *     whole-scan wall-clock rather than real page load.
 *
 * The point is a safety net: if Phase 1 changes a number, a failing test forces
 * us to acknowledge it on purpose instead of shipping a silent regression.
 */
describe("computeSeoScore (current behavior)", () => {
  it("returns all zeros for an empty crawl", () => {
    expect(computeSeoScore([])).toEqual({
      technical: 0,
      content: 0,
      media: 0,
      aeo: 0,
      overall: 0,
    });
  });

  it("scores a fully-optimized page 100 across the board", () => {
    expect(computeSeoScore([makeOptimizedPage()])).toEqual({
      technical: 100,
      content: 100,
      media: 100,
      aeo: 100,
      overall: 100,
    });
  });

  it("scores an empty 200 page: technical/media buoyed, content/aeo zero", () => {
    // Default page: 200 OK, not indexable, load_time 0 (counts as fast),
    // no title/meta/h1/words, no images.
    const score = computeSeoScore([makeScanResult()]);
    // technical = (ok 100 + indexable 0 + fast 100) / 3 = 66.67 -> 67
    expect(score.technical).toBe(67);
    expect(score.content).toBe(0);
    // KNOWN NEUTRAL DEFAULT: no images -> media 100 (Phase 1 will revisit).
    expect(score.media).toBe(100);
    expect(score.aeo).toBe(0);
    // overall = (66.67 + 0 + 100 + 0) / 4 = 41.67 -> 42
    expect(score.overall).toBe(42);
  });

  it("media reflects alt-text coverage across all images", () => {
    const page = makeOptimizedPage({
      images: [
        { src: "https://example.com/a.png", alt: "has alt" },
        { src: "https://example.com/b.png", alt: "" },
      ],
    });
    // 1 of 2 images has alt -> media 50
    expect(computeSeoScore([page]).media).toBe(50);
  });

  it("an indexable page loses a third of technical when flagged slow", () => {
    // KNOWN INPUT ISSUE: `load_time_ms` is currently whole-scan wall-clock.
    const slow = makeOptimizedPage({ load_time_ms: 5000 });
    const score = computeSeoScore([slow]);
    // technical = (ok 100 + indexable 100 + fast 0) / 3 = 66.67 -> 67
    expect(score.technical).toBe(67);
    // overall = (66.67 + 100 + 100 + 100) / 4 = 91.67 -> 92
    expect(score.overall).toBe(92);
  });

  it("does not let a bot-blocked-style empty page fabricate content signals", () => {
    // A page that returned but has no extractable content scores 0 content/aeo.
    const blanked = makeScanResult({ status: 200, is_indexable: true });
    const score = computeSeoScore([blanked]);
    expect(score.content).toBe(0);
    expect(score.aeo).toBe(0);
  });
});
