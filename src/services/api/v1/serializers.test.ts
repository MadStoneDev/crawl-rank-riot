import { describe, it, expect } from "vitest";
import {
  serializeIssue,
  serializeReport,
  serializeJob,
  serializeUsage,
  jobStatusFromScan,
  CATEGORY_LABELS,
  serializeProject,
  serializePageListItem,
  serializePageDetail,
  domainOf,
  isSameSite,
} from "./serializers";
import type { ScoreReport } from "../../../scoring/score-report";

describe("serializeIssue", () => {
  it("exposes category, label, severity and the speed tag", () => {
    const issue = serializeIssue({
      issue_type: "oversized_images",
      severity: "medium",
      description: "Images over 400 KB",
      page_url: "https://ex.com/a",
    });
    expect(issue).toMatchObject({
      object: "issue",
      type: "oversized_images",
      category: "media",
      category_label: "Media",
      severity: "medium",
      is_speed: true, // image performance
      page_url: "https://ex.com/a",
    });
  });

  it("marks page-performance issues as technical + speed", () => {
    const issue = serializeIssue({ issue_type: "slow_page", severity: "high", description: null });
    expect(issue.category).toBe("technical");
    expect(issue.is_speed).toBe(true);
    expect(issue.page_url).toBeNull();
  });

  it("routes the lead-answer block to AEO and non-perf issues off the speed tag", () => {
    const answer = serializeIssue({ issue_type: "missing_answer_block", severity: "low", description: null });
    expect(answer.category).toBe("aeo");
    expect(answer.is_speed).toBe(false);
  });

  it("falls back to technical/low for an unknown type or bad severity", () => {
    const issue = serializeIssue({ issue_type: "some_future_type", severity: "WAT", description: null });
    expect(issue.category).toBe("technical");
    expect(issue.severity).toBe("low");
  });

  it("omits details when not provided and includes it when present", () => {
    expect(serializeIssue({ issue_type: "noindex", severity: "medium", description: null })).not.toHaveProperty("details");
    const withDetails = serializeIssue({ issue_type: "noindex", severity: "medium", description: null, details: { foo: 1 } });
    expect(withDetails.details).toEqual({ foo: 1 });
  });
});

describe("serializeReport", () => {
  const report: ScoreReport = {
    version: 3,
    overall: 82,
    overallPassRate: 90,
    scoreModel: "weighted-v1",
    blocked: false,
    capped: "high",
    categories: {
      technical: { score: 80, passRate: 95, checks: [] },
      content: { score: 85, passRate: 88, checks: [] },
      media: { score: 70, passRate: 60, checks: [] },
      aeo: { score: 90, passRate: 100, checks: [] },
    },
    pages: {},
    deductions: [
      {
        issueType: "oversized_images",
        category: "media",
        severity: "medium",
        affectedPages: 4,
        scoredPages: 10,
        share: 0.4,
        penalty: 6,
        siteLevel: false,
      },
    ],
  };

  it("emits the four categories with machine value + label + both score axes", () => {
    const r = serializeReport("job_1", report);
    expect(r.categories).toHaveLength(4);
    const media = r.categories.find((c) => c.category === "media")!;
    expect(media).toMatchObject({ category: "media", label: "Media", score: 70, pass_rate: 60 });
    expect(r.categories.map((c) => c.label)).toEqual(["Technical", "Content", "Media", "AEO"]);
  });

  it("carries version, model, cap and a speed-tagged deduction", () => {
    const r = serializeReport("job_1", report);
    expect(r).toMatchObject({ score_version: 3, score_model: "weighted-v1", capped: "high", overall: 82, overall_pass_rate: 90 });
    expect(r.deductions[0]).toMatchObject({ issue_type: "oversized_images", category: "media", label: "Media", is_speed: true, penalty: 6 });
  });

  it("defaults optional fields when absent", () => {
    const bare: ScoreReport = { ...report, scoreModel: undefined, capped: undefined, overallPassRate: undefined, deductions: undefined };
    const r = serializeReport("job_1", bare);
    expect(r.score_model).toBeNull();
    expect(r.capped).toBeNull();
    expect(r.overall_pass_rate).toBeNull();
    expect(r.deductions).toEqual([]);
  });
});

describe("serializeJob", () => {
  const job = { id: "job_abc", type: "seo", project_id: "proj_1", created_at: "2026-10-22T00:00:00Z" };

  it("maps scan status to job status and builds sub-resource links", () => {
    const j = serializeJob(job, {
      status: "in_progress",
      started_at: "2026-10-22T00:00:01Z",
      completed_at: null,
      pages_scanned: 12,
      links_scanned: 40,
      issues_found: 3,
      failure_reason: null,
    });
    expect(j.status).toBe("running");
    expect(j.stats).toEqual({ pages_scanned: 12, links_scanned: 40, issues_found: 3 });
    expect(j.links).toEqual({
      self: "/api/v1/jobs/job_abc",
      report: "/api/v1/jobs/job_abc/report",
      issues: "/api/v1/jobs/job_abc/issues",
      pages: "/api/v1/jobs/job_abc/pages",
    });
  });

  it("defaults stats to zero when no scan row exists yet", () => {
    const j = serializeJob(job, null);
    expect(j.status).toBe("queued");
    expect(j.stats).toEqual({ pages_scanned: 0, links_scanned: 0, issues_found: 0 });
  });

  it("defaults Stage 4 attribution/scope when absent, and echoes them when present", () => {
    const bare = serializeJob(job, null);
    expect(bare.scope).toBe("site");
    expect(bare.modules).toBeNull();
    expect(bare.external_ref).toBeNull();
    expect(bare.metadata).toEqual({});

    const rich = serializeJob(
      { ...job, scope: "page", modules: ["fetch_extract", "tech_fingerprint"], external_ref: "crm-42", metadata: { team: "x" } },
      null,
    );
    expect(rich.scope).toBe("page");
    expect(rich.modules).toEqual(["fetch_extract", "tech_fingerprint"]);
    expect(rich.external_ref).toBe("crm-42");
    expect(rich.metadata).toEqual({ team: "x" });
  });
});

describe("serializeProject / serializePage (Stage 4)", () => {
  it("derives the domain and echoes attribution", () => {
    const p = serializeProject(
      { id: "p1", name: "Acme", url: "https://www.acme.test/", created_at: "2026-10-24T00:00:00Z" },
      { external_ref: "crm-1", metadata: { tier: "pro" } },
    );
    expect(p.object).toBe("project");
    expect(p.domain).toBe("acme.test");
    expect(p.external_ref).toBe("crm-1");
    expect(p.metadata).toEqual({ tier: "pro" });
  });

  it("serializes a compact page list item and a full detail with gated content", () => {
    const row = {
      id: "jp1",
      url: "https://acme.test/about",
      http_status: 200,
      data: { url: "https://acme.test/about", http_status: 200, title: "About", word_count: 320 } as any,
      content: "the cleaned body text",
      modules: { tech_fingerprint: { platform: "wordpress" } },
    };
    const item = serializePageListItem(row);
    expect(item).toEqual({
      object: "page",
      id: "jp1",
      url: "https://acme.test/about",
      http_status: 200,
      title: "About",
      word_count: 320,
      modules: { tech_fingerprint: { platform: "wordpress" } },
    });

    const withoutContent = serializePageDetail(row, false);
    expect(withoutContent.title).toBe("About");
    expect("content" in withoutContent).toBe(false);

    const withContent = serializePageDetail(row, true);
    expect(withContent.content).toBe("the cleaned body text");
  });
});

describe("jobStatusFromScan", () => {
  it("maps each internal status", () => {
    expect(jobStatusFromScan("pending")).toBe("queued");
    expect(jobStatusFromScan("in_progress")).toBe("running");
    expect(jobStatusFromScan("completed")).toBe("completed");
    expect(jobStatusFromScan("failed")).toBe("failed");
    expect(jobStatusFromScan("cancelled")).toBe("cancelled");
  });
});

describe("serializeUsage", () => {
  it("computes remaining quota, and null for unlimited", () => {
    expect(serializeUsage("2026-10-01", 120, 8, 100).quota_remaining).toBe(92);
    expect(serializeUsage("2026-10-01", 120, 8, null).quota_remaining).toBeNull();
    expect(serializeUsage("2026-10-01", 120, 150, 100).quota_remaining).toBe(0);
  });
});

describe("CATEGORY_LABELS", () => {
  it("covers all four categories", () => {
    expect(CATEGORY_LABELS).toEqual({ technical: "Technical", content: "Content", media: "Media", aeo: "AEO" });
  });
});

describe("domainOf / isSameSite (apex == www, scheme- and slash-insensitive)", () => {
  it("normalises apex, www, scheme and trailing slash to the same domain", () => {
    for (const u of [
      "https://acme.test",
      "http://acme.test/",
      "https://www.acme.test/",
      "http://www.acme.test/pricing?x=1",
      "acme.test",
      "www.acme.test/path",
    ]) {
      expect(domainOf(u)).toBe("acme.test");
    }
  });

  it("treats apex and www as the same site, both directions", () => {
    expect(isSameSite("https://www.acme.test/contact", "acme.test")).toBe(true);
    expect(isSameSite("https://acme.test/contact", "acme.test")).toBe(true);
    // Project registered as www (domainOf strips it) still matches the apex.
    expect(isSameSite("https://acme.test/x", domainOf("https://www.acme.test/"))).toBe(true);
  });

  it("allows subdomains but rejects other sites and look-alikes", () => {
    expect(isSameSite("https://blog.acme.test/post", "acme.test")).toBe(true);
    expect(isSameSite("https://evil.example/acme.test", "acme.test")).toBe(false);
    expect(isSameSite("https://evil-acme.test/", "acme.test")).toBe(false);
    expect(isSameSite("not a url", "acme.test")).toBe(false);
  });
});
