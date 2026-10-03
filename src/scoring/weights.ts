// Single source of truth for score weighting (P1.2 severity × volume model).
// Tuning lives here so calibration is a one-file change.

export type ScoreCategory = "technical" | "content" | "media" | "aeo";
export type Severity = "critical" | "high" | "medium" | "low";

/** Max points a single check can deduct, by severity. */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 6,
  low: 2,
};

/** Score caps when open issues of a given severity exist. */
export const CRITICAL_CAP = 79;
export const HIGH_CAP = 89;

/**
 * Site-level / template-level issue types: one occurrence affects the whole
 * site, so they count once with share = 1 regardless of page count.
 */
export const SITE_LEVEL_ISSUE_TYPES = new Set<string>([
  "missing_llms_txt",
  "empty_llms_txt",
  "missing_robots_txt",
  "ai_bots_blocked",
  "missing_sitemap",
  "invalid_sitemap",
  "sitemap_missing_lastmod",
  "pages_not_in_sitemap",
  "slow_server_response",
]);

/** Which score category each issue type belongs to. Unknown → technical. */
export const ISSUE_CATEGORY: Record<string, ScoreCategory> = {
  // technical
  broken_internal_link: "technical",
  not_found: "technical",
  server_error: "technical",
  redirect_chain: "technical",
  redirect_loop: "technical",
  mixed_content: "technical",
  missing_security_headers: "technical",
  missing_viewport_meta: "technical",
  missing_html_lang: "technical",
  canonical_mismatch: "technical",
  missing_canonical: "technical",
  orphan_page: "technical",
  slow_page: "technical",
  slow_server_response: "technical",
  large_page_size: "technical",
  url_structure_issues: "technical",
  js_rendering_dependency: "technical",
  no_resource_hints: "technical",
  hreflang_issues: "technical",
  missing_form_labels: "technical",
  no_aria_landmarks: "technical",
  missing_skip_nav: "technical",
  tabindex_misuse: "technical",
  missing_robots_txt: "technical",
  missing_sitemap: "technical",
  invalid_sitemap: "technical",
  sitemap_missing_lastmod: "technical",
  pages_not_in_sitemap: "technical",
  // content
  missing_title: "content",
  empty_page_title: "content",
  title_too_long: "content",
  title_too_short: "content",
  missing_meta_description: "content",
  meta_description_too_long: "content",
  meta_description_too_short: "content",
  missing_h1: "content",
  multiple_h1: "content",
  thin_content: "content",
  duplicate_content: "content",
  duplicate_title: "content",
  duplicate_meta_description: "content",
  poor_readability: "content",
  keyword_not_in_title: "content",
  non_descriptive_anchor_text: "content",
  heading_hierarchy_invalid: "content",
  missing_answer_block: "content",
  // media
  missing_image_alt: "media",
  missing_image_dimensions: "media",
  missing_image_lazy_loading: "media",
  oversized_images: "media",
  non_modern_image_format: "media",
  // aeo
  invalid_structured_data: "aeo",
  missing_structured_data: "aeo",
  missing_open_graph: "aeo",
  incomplete_open_graph: "aeo",
  missing_twitter_card: "aeo",
  faq_without_schema: "aeo",
  missing_podcast_schema: "aeo",
  missing_llms_txt: "aeo",
  empty_llms_txt: "aeo",
  ai_bots_blocked: "aeo",
};

export function categoryForIssueType(type: string): ScoreCategory {
  return ISSUE_CATEGORY[type] ?? "technical";
}

export function isSiteLevelIssueType(type: string): boolean {
  return SITE_LEVEL_ISSUE_TYPES.has(type);
}
