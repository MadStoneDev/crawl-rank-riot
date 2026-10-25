import { describe, it, expect } from "vitest";
import { composePipeline, SHARED_POST_CRAWL_MODULES } from "./compose";

const names = (mode: "seo" | "audit", opts?: Parameters<typeof composePipeline>[1]) =>
  composePipeline(mode, opts).map((m) => m.name);

describe("composePipeline", () => {
  it("runs the post-crawl modules in the documented order", () => {
    expect(SHARED_POST_CRAWL_MODULES.map((m) => m.name)).toEqual([
      "store_pages",
      "bot_block_detection",
      "site_analysis",
      "issue_detection",
      "backlinks",
    ]);
  });

  it("default (no selection) is unchanged for a non-API scan", () => {
    expect(names("seo")).toEqual(SHARED_POST_CRAWL_MODULES.map((m) => m.name));
    expect(names("seo")).toEqual(names("audit"));
  });

  it("appends the page snapshot for a default API job", () => {
    expect(names("seo", { apiJob: true })).toEqual([
      ...SHARED_POST_CRAWL_MODULES.map((m) => m.name),
      "api_job_pages",
    ]);
  });

  it("selects only the requested modules over the mandatory base (API)", () => {
    expect(names("seo", { apiJob: true, modules: ["tech_fingerprint", "business_info"] })).toEqual([
      "store_pages",
      "bot_block_detection",
      "tech_fingerprint",
      "business_info",
      "api_job_pages",
    ]);
  });

  it("maps issue_detection to site_analysis + issue_detection and omits backlinks", () => {
    const n = names("seo", { apiJob: true, modules: ["issue_detection"] });
    expect(n).toEqual([
      "store_pages",
      "bot_block_detection",
      "site_analysis",
      "issue_detection",
      "api_job_pages",
    ]);
    expect(n).not.toContain("backlinks");
  });

  it("'scoring' is not a post-crawl module (handled by the strategy)", () => {
    expect(names("seo", { apiJob: true, modules: ["scoring"] })).toEqual([
      "store_pages",
      "bot_block_detection",
      "api_job_pages",
    ]);
  });

  it("exposes a run() on every module", () => {
    for (const m of SHARED_POST_CRAWL_MODULES) {
      expect(typeof m.run).toBe("function");
    }
  });
});
