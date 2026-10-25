import { describe, it, expect } from "vitest";
import {
  categoryForIssueType,
  isSpeedIssueType,
  SPEED_ISSUE_TYPES,
  ISSUE_CATEGORY,
} from "./weights";

// The crawler's issue→category map is the single source of truth for the
// frontend's display groups (F-D09). These known-answer tests pin the
// categorisation so a display-bucket regression fails here, in the crawler,
// rather than silently in the UI.
describe("ISSUE_CATEGORY (taxonomy source of truth)", () => {
  it("categorises image issues as media", () => {
    expect(categoryForIssueType("missing_image_alt")).toBe("media");
    expect(categoryForIssueType("oversized_images")).toBe("media");
    expect(categoryForIssueType("non_modern_image_format")).toBe("media");
    expect(categoryForIssueType("missing_image_dimensions")).toBe("media");
  });

  it("categorises canonical / sitemap / URL issues as technical", () => {
    expect(categoryForIssueType("missing_canonical")).toBe("technical");
    expect(categoryForIssueType("canonical_mismatch")).toBe("technical");
    expect(categoryForIssueType("url_structure_issues")).toBe("technical");
    expect(categoryForIssueType("pages_not_in_sitemap")).toBe("technical");
    expect(categoryForIssueType("orphan_page")).toBe("technical");
  });

  it("categorises social/share tags as aeo", () => {
    expect(categoryForIssueType("missing_open_graph")).toBe("aeo");
    expect(categoryForIssueType("incomplete_open_graph")).toBe("aeo");
    expect(categoryForIssueType("missing_twitter_card")).toBe("aeo");
  });

  it("categorises the lead-answer block as aeo, not content (F-D09)", () => {
    // It is an answer-engine-readiness signal and belongs with the other AEO
    // checks even though the remedy is a short paragraph.
    expect(categoryForIssueType("missing_answer_block")).toBe("aeo");
  });

  it("defaults unknown issue types to technical", () => {
    expect(categoryForIssueType("noindex")).toBe("technical");
    expect(categoryForIssueType("some_future_type")).toBe("technical");
  });

  it("only uses the four known categories", () => {
    for (const cat of Object.values(ISSUE_CATEGORY)) {
      expect(["technical", "content", "media", "aeo"]).toContain(cat);
    }
  });
});

describe("speed tag (cross-category, data only)", () => {
  it("flags both page-performance and image-performance issues", () => {
    expect(isSpeedIssueType("slow_page")).toBe(true);
    expect(isSpeedIssueType("slow_server_response")).toBe(true);
    expect(isSpeedIssueType("large_page_size")).toBe(true);
    expect(isSpeedIssueType("oversized_images")).toBe(true);
    expect(isSpeedIssueType("non_modern_image_format")).toBe(true);
    expect(isSpeedIssueType("missing_image_dimensions")).toBe(true);
  });

  it("does not flag non-performance issues", () => {
    expect(isSpeedIssueType("missing_title")).toBe(false);
    expect(isSpeedIssueType("missing_image_alt")).toBe(false);
    expect(isSpeedIssueType("missing_canonical")).toBe(false);
  });

  it("draws from more than one score category", () => {
    const cats = new Set(
      [...SPEED_ISSUE_TYPES].map((t) => categoryForIssueType(t)),
    );
    expect(cats.has("technical")).toBe(true);
    expect(cats.has("media")).toBe(true);
  });
});
