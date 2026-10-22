import { describe, it, expect } from "vitest";
import { composePipeline, SHARED_POST_CRAWL_MODULES } from "./compose";

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

  it("composes the same post-crawl modules for seo and audit", () => {
    const seo = composePipeline("seo").map((m) => m.name);
    const audit = composePipeline("audit").map((m) => m.name);
    expect(seo).toEqual(audit);
    expect(seo).toEqual(SHARED_POST_CRAWL_MODULES.map((m) => m.name));
  });

  it("exposes a run() on every module", () => {
    for (const m of SHARED_POST_CRAWL_MODULES) {
      expect(typeof m.run).toBe("function");
    }
  });
});
