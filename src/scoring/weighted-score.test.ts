import { describe, it, expect } from "vitest";
import { computeWeightedScore, type IssueAggregate } from "./weighted-score";

describe("computeWeightedScore (P1.2 severity × volume)", () => {
  it("a clean site scores 100", () => {
    expect(computeWeightedScore([], 42).overall).toBe(100);
  });

  it("deducts W×sqrt(share) and rounds", () => {
    // medium (W=6) on 41 of 42 pages: share≈0.976, penalty≈6×0.988≈5.93 → 100-5.93≈94
    const r = computeWeightedScore(
      [{ issueType: "missing_image_dimensions", severity: "medium", affectedPages: 41 }],
      42,
    );
    expect(r.overall).toBe(94);
    expect(r.deductions[0].penalty).toBeCloseTo(5.93, 1);
    expect(r.categories.media).toBe(94);
    expect(r.categories.content).toBe(100); // untouched category
  });

  it("caps each check at its severity weight (one noisy check can't sink it)", () => {
    // Even at share=1 a medium removes exactly 6, not more.
    const r = computeWeightedScore(
      [{ issueType: "thin_content", severity: "medium", affectedPages: 42 }],
      42,
    );
    expect(r.overall).toBe(94);
  });

  it("treats site-level issues as share=1 regardless of page count", () => {
    const r = computeWeightedScore(
      [{ issueType: "empty_llms_txt", severity: "low", affectedPages: 0 }],
      42,
    );
    expect(r.deductions[0].siteLevel).toBe(true);
    expect(r.deductions[0].share).toBe(1);
    expect(r.overall).toBe(98); // 100 - 2
  });

  it("applies the critical cap on top of deductions", () => {
    const r = computeWeightedScore(
      [{ issueType: "server_error", severity: "critical", affectedPages: 1 }],
      42,
    );
    expect(r.capped).toBe("critical");
    expect(r.overall).toBeLessThanOrEqual(79);
  });

  it("applies the high cap", () => {
    const r = computeWeightedScore(
      [{ issueType: "multiple_h1", severity: "high", affectedPages: 4 }],
      11,
    );
    expect(r.capped).toBe("high");
    expect(r.overall).toBeLessThanOrEqual(89);
  });

  it("ranks deductions biggest-first", () => {
    const aggs: IssueAggregate[] = [
      { issueType: "empty_llms_txt", severity: "low", affectedPages: 0 },
      { issueType: "multiple_h1", severity: "high", affectedPages: 11 },
      { issueType: "thin_content", severity: "medium", affectedPages: 3 },
    ];
    const r = computeWeightedScore(aggs, 11);
    expect(r.deductions[0].issueType).toBe("multiple_h1");
  });
});
