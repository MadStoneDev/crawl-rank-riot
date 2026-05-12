import { ScanResult } from "../types";
import { Json } from "../database.types";
import { getSupabaseServiceClient } from "./database/client";

type IssueSeverity = "critical" | "high" | "medium" | "low";

interface DetectedIssue {
  project_id: string;
  page_id: string;
  scan_id: string;
  issue_type: string;
  severity: IssueSeverity;
  description: string;
  details: Json | null;
}

/**
 * Detect SEO issues from scan results and store them in the database.
 *
 * Issues are accumulated across scans so that historical data is preserved
 * for trend analysis. The frontend filters by scan_id when it needs
 * current-scan issues only.
 */
export async function detectAndStoreIssues(
  results: ScanResult[],
  projectId: string,
  scanId: string,
): Promise<number> {
  const supabase = getSupabaseServiceClient();

  try {
    // Step 1: Look up page IDs by (project_id, url)
    const urls = results.map((r) => r.url);
    const pageIdMap = await resolvePageIds(projectId, urls);

    if (pageIdMap.size === 0) {
      console.log("No page IDs found -- skipping issue detection");
      return 0;
    }

    // Step 2: Fetch broken internal links for this project
    const brokenLinks = await fetchBrokenLinks(projectId);

    // Step 3: Detect issues for each page
    const allIssues: DetectedIssue[] = [];

    for (const result of results) {
      const pageId = pageIdMap.get(result.url);
      if (!pageId) {
        continue;
      }

      const pageIssues = analyzePageIssues(result, projectId, pageId, scanId);
      allIssues.push(...pageIssues);
    }

    // Step 3b: Detect cross-page duplicate titles and meta descriptions
    const crossPageIssues = detectCrossPageDuplicates(
      results,
      pageIdMap,
      projectId,
      scanId,
    );
    allIssues.push(...crossPageIssues);

    // Step 3c: Add broken link issues (sourced from page_links table)
    for (const link of brokenLinks) {
      allIssues.push({
        project_id: projectId,
        page_id: link.source_page_id,
        scan_id: scanId,
        issue_type: "broken_internal_link",
        severity: "high",
        description: `Broken internal link to ${link.destination_url} (HTTP ${link.http_status ?? "unknown"})`,
        details: {
          destination_url: link.destination_url,
          http_status: link.http_status ?? null,
          anchor_text: link.anchor_text ?? null,
        },
      });
    }

    // Step 4: Insert new issues (old issues are kept for historical trends).
    if (allIssues.length === 0) {
      console.log("No issues detected for this scan");
      return 0;
    }

    const batchSize = 50;
    let totalInserted = 0;
    let insertFailed = false;

    // Step 5: Insert new issues in batches
    for (let i = 0; i < allIssues.length; i += batchSize) {
      const batch = allIssues.slice(i, i + batchSize);
      const { error: insertError } = await supabase
        .from("issues")
        .insert(batch);

      if (insertError) {
        console.error(
          `Error inserting issues batch ${Math.floor(i / batchSize) + 1}:`,
          insertError,
        );
        insertFailed = true;
      } else {
        totalInserted += batch.length;
      }
    }

    if (insertFailed && totalInserted === 0) {
      console.error(
        "All issue inserts failed for this scan",
      );
    }

    console.log(
      `Issue detection complete: ${totalInserted} issues found for project ${projectId} (scan ${scanId})`,
    );
    return totalInserted;
  } catch (error) {
    console.error("Error in issue detection:", error);
    throw error;
  }
}

/**
 * Resolve page UUIDs from the pages table by (project_id, url).
 */
async function resolvePageIds(
  projectId: string,
  urls: string[],
): Promise<Map<string, string>> {
  const supabase = getSupabaseServiceClient();
  const map = new Map<string, string>();

  // Supabase .in() has a practical limit, so batch the lookups
  const batchSize = 200;
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from("pages")
      .select("id, url")
      .eq("project_id", projectId)
      .in("url", batch);

    if (error) {
      console.error("Error resolving page IDs:", error);
      continue;
    }

    for (const row of data ?? []) {
      map.set(row.url, row.id);
    }
  }

  return map;
}

/**
 * Fetch broken internal links for a project from the page_links table.
 */
async function fetchBrokenLinks(projectId: string): Promise<
  Array<{
    source_page_id: string;
    destination_url: string;
    http_status: number | null;
    anchor_text: string | null;
  }>
> {
  const supabase = getSupabaseServiceClient();

  const { data, error } = await supabase
    .from("page_links")
    .select("source_page_id, destination_url, http_status, anchor_text")
    .eq("project_id", projectId)
    .eq("link_type", "internal")
    .eq("is_broken", true);

  if (error) {
    console.error("Error fetching broken links:", error);
    return [];
  }

  return data ?? [];
}

/**
 * Detect cross-page duplicates: pages sharing the same non-empty title
 * or meta description. Creates one issue per affected page.
 */
function detectCrossPageDuplicates(
  results: ScanResult[],
  pageIdMap: Map<string, string>,
  projectId: string,
  scanId: string,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // Group pages by title
  const titleMap = new Map<string, { url: string; pageId: string }[]>();
  for (const result of results) {
    const pageId = pageIdMap.get(result.url);
    if (!pageId) continue;
    const title = result.title?.trim();
    if (!title) continue;
    const existing = titleMap.get(title) || [];
    existing.push({ url: result.url, pageId });
    titleMap.set(title, existing);
  }

  for (const [title, pages] of titleMap) {
    if (pages.length < 2) continue;
    const duplicateUrls = pages.map((p) => p.url);
    for (const page of pages) {
      issues.push({
        project_id: projectId,
        page_id: page.pageId,
        scan_id: scanId,
        issue_type: "duplicate_title",
        severity: "medium",
        description: `Duplicate title shared with ${pages.length - 1} other page(s): "${title.length > 80 ? title.slice(0, 80) + "…" : title}"`,
        details: {
          title,
          duplicate_urls: duplicateUrls.filter((u) => u !== page.url),
        },
      });
    }
  }

  // Group pages by meta description
  const descMap = new Map<string, { url: string; pageId: string }[]>();
  for (const result of results) {
    const pageId = pageIdMap.get(result.url);
    if (!pageId) continue;
    const desc = result.meta_description?.trim();
    if (!desc) continue;
    const existing = descMap.get(desc) || [];
    existing.push({ url: result.url, pageId });
    descMap.set(desc, existing);
  }

  for (const [desc, pages] of descMap) {
    if (pages.length < 2) continue;
    const duplicateUrls = pages.map((p) => p.url);
    for (const page of pages) {
      issues.push({
        project_id: projectId,
        page_id: page.pageId,
        scan_id: scanId,
        issue_type: "duplicate_meta_description",
        severity: "medium",
        description: `Duplicate meta description shared with ${pages.length - 1} other page(s): "${desc.length > 80 ? desc.slice(0, 80) + "…" : desc}"`,
        details: {
          meta_description: desc,
          duplicate_urls: duplicateUrls.filter((u) => u !== page.url),
        },
      });
    }
  }

  return issues;
}

/**
 * Analyze a single page's scan result and return all detected issues.
 */
function analyzePageIssues(
  result: ScanResult,
  projectId: string,
  pageId: string,
  scanId: string,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  const addIssue = (
    issueType: string,
    severity: IssueSeverity,
    description: string,
    details: Json | null = null,
  ) => {
    issues.push({
      project_id: projectId,
      page_id: pageId,
      scan_id: scanId,
      issue_type: issueType,
      severity,
      description,
      details,
    });
  };

  // ── CRITICAL ──────────────────────────────────────────────────────────

  if (result.status >= 500 && result.status < 600) {
    addIssue(
      "server_error",
      "critical",
      `Page returned HTTP ${result.status} server error`,
      { status_code: result.status, url: result.url },
    );
  }

  if (result.status === 404) {
    addIssue("not_found", "critical", "Page returned HTTP 404 Not Found", {
      url: result.url,
    });
  }

  // ── HIGH ──────────────────────────────────────────────────────────────

  if (!result.title || result.title.trim() === "") {
    addIssue("missing_title", "high", "Page is missing a title tag", {
      url: result.url,
    });
  }

  if (!result.meta_description || result.meta_description.trim() === "") {
    addIssue(
      "missing_meta_description",
      "high",
      "Page is missing a meta description",
      { url: result.url },
    );
  }

  if (!result.h1s || result.h1s.length === 0) {
    addIssue("missing_h1", "high", "Page is missing an H1 heading tag", {
      url: result.url,
    });
  }

  if (result.h1s && result.h1s.length > 1) {
    addIssue(
      "multiple_h1",
      "high",
      `Page has ${result.h1s.length} H1 tags (should have exactly one)`,
      { url: result.url, h1s: result.h1s, count: result.h1s.length },
    );
  }

  // Note: broken internal links are handled separately via page_links query

  // ── MEDIUM ────────────────────────────────────────────────────────────

  if (result.title && result.title.trim().length > 0) {
    const titleLen = result.title.trim().length;
    if (titleLen > 60) {
      addIssue(
        "title_too_long",
        "medium",
        `Title tag is too long (${titleLen} characters, recommended max 60)`,
        { url: result.url, title: result.title, length: titleLen },
      );
    } else if (titleLen < 10) {
      addIssue(
        "title_too_short",
        "medium",
        `Title tag is too short (${titleLen} characters, recommended min 10)`,
        { url: result.url, title: result.title, length: titleLen },
      );
    }
  }

  if (result.meta_description && result.meta_description.trim().length > 0) {
    const descLen = result.meta_description.trim().length;
    if (descLen > 160) {
      addIssue(
        "meta_description_too_long",
        "medium",
        `Meta description is too long (${descLen} characters, recommended max 160)`,
        {
          url: result.url,
          meta_description: result.meta_description,
          length: descLen,
        },
      );
    } else if (descLen < 50) {
      addIssue(
        "meta_description_too_short",
        "medium",
        `Meta description is too short (${descLen} characters, recommended min 50)`,
        {
          url: result.url,
          meta_description: result.meta_description,
          length: descLen,
        },
      );
    }
  }

  if (result.word_count < 300) {
    addIssue(
      "thin_content",
      "medium",
      `Page has thin content (${result.word_count} words, recommended min 300)`,
      { url: result.url, word_count: result.word_count },
    );
  }

  if (!result.canonical_url) {
    addIssue(
      "missing_canonical",
      "medium",
      "Page is missing a canonical URL",
      { url: result.url },
    );
  }

  if (result.has_robots_noindex) {
    addIssue(
      "noindex",
      "medium",
      "Page is blocked from indexing by robots noindex directive",
      { url: result.url },
    );
  }

  if (
    !result.open_graph ||
    Object.keys(result.open_graph).length === 0
  ) {
    addIssue(
      "missing_open_graph",
      "medium",
      "Page is missing Open Graph meta tags",
      { url: result.url },
    );
  }

  // ── LOW ───────────────────────────────────────────────────────────────

  if (
    !result.twitter_card ||
    Object.keys(result.twitter_card).length === 0
  ) {
    addIssue(
      "missing_twitter_card",
      "low",
      "Page is missing Twitter Card meta tags",
      { url: result.url },
    );
  }

  if (!result.schema_types || result.schema_types.length === 0) {
    addIssue(
      "missing_structured_data",
      "low",
      "Page has no structured data / schema markup",
      { url: result.url },
    );
  }

  const THREE_MB = 3 * 1024 * 1024;
  if (result.size_bytes > THREE_MB) {
    const sizeMB = (result.size_bytes / (1024 * 1024)).toFixed(2);
    addIssue(
      "large_page_size",
      "low",
      `Page size is ${sizeMB} MB (recommended max 3 MB)`,
      { url: result.url, size_bytes: result.size_bytes, size_mb: sizeMB },
    );
  }

  if (result.load_time_ms > 3000) {
    const loadTimeSec = (result.load_time_ms / 1000).toFixed(2);
    addIssue(
      "slow_page",
      "low",
      `Page load time is ${loadTimeSec}s (recommended max 3s)`,
      { url: result.url, load_time_ms: result.load_time_ms },
    );
  }

  if (result.images && result.images.length > 0) {
    const missingAlt = result.images.filter(
      (img) => !img.alt || img.alt.trim() === "",
    );
    if (missingAlt.length > 0) {
      addIssue(
        "missing_image_alt",
        "low",
        `${missingAlt.length} image(s) missing alt text`,
        {
          url: result.url,
          count: missingAlt.length,
          images: missingAlt.slice(0, 10).map((img) => img.src),
        },
      );
    }
  }

  // ── NEW CHECKS ───────────────────────────────────────────────────────

  // Heading hierarchy validation
  if (result.heading_hierarchy_valid === false) {
    const hierarchyIssues = result.heading_hierarchy_issues ?? [];
    addIssue(
      "heading_hierarchy_invalid",
      "medium",
      `Heading hierarchy is invalid: ${hierarchyIssues.length > 0 ? hierarchyIssues.join("; ") : "structural issues detected"}`,
      {
        url: result.url,
        issues: hierarchyIssues,
      },
    );
  }

  // Missing viewport meta tag
  if (result.has_viewport_meta === false) {
    addIssue(
      "missing_viewport_meta",
      "medium",
      "Page is missing a viewport meta tag, which is critical for mobile rendering and mobile SEO",
      { url: result.url },
    );
  }

  // Mixed content (HTTP resources on HTTPS pages)
  if (result.has_mixed_content === true) {
    addIssue(
      "mixed_content",
      "high",
      "Page loads HTTP resources on an HTTPS page, causing mixed content warnings and potential security issues",
      { url: result.url },
    );
  }

  // URL structure issues
  if (result.url_issues && result.url_issues.length > 0) {
    addIssue(
      "url_structure_issues",
      "low",
      `URL has ${result.url_issues.length} structural issue(s): ${result.url_issues.join("; ")}`,
      {
        url: result.url,
        issues: result.url_issues,
      },
    );
  }

  // Canonical mismatch
  if (
    result.canonical_url != null &&
    result.canonical_is_self === false
  ) {
    addIssue(
      "canonical_mismatch",
      "medium",
      `Canonical URL does not match the page URL (canonical points to ${result.canonical_url})`,
      {
        url: result.url,
        canonical_url: result.canonical_url,
      },
    );
  }

  // Missing lazy loading on images (only flag if more than 3 images)
  if (result.images && result.images.length > 3) {
    const hasLazy = result.images.some((img) => img.loading === "lazy");
    if (!hasLazy) {
      addIssue(
        "missing_image_lazy_loading",
        "low",
        `None of the ${result.images.length} images use lazy loading`,
        {
          url: result.url,
          image_count: result.images.length,
        },
      );
    }
  }

  // Non-modern image formats
  if (result.images && result.images.length > 0) {
    const modernFormats = new Set(["webp", "avif", "svg"]);
    const formatCounts: Record<string, number> = {};
    let nonModernCount = 0;

    for (const img of result.images) {
      const format = img.format?.toLowerCase() ?? guessFormatFromSrc(img.src);
      formatCounts[format] = (formatCounts[format] ?? 0) + 1;
      if (!modernFormats.has(format)) {
        nonModernCount++;
      }
    }

    if (nonModernCount > result.images.length / 2) {
      addIssue(
        "non_modern_image_format",
        "low",
        `${nonModernCount} of ${result.images.length} images use legacy formats (not WebP, AVIF, or SVG)`,
        {
          url: result.url,
          format_breakdown: formatCounts,
          non_modern_count: nonModernCount,
          total_images: result.images.length,
        },
      );
    }
  }

  // Missing hreflang tags (placeholder — not auto-detected yet)
  // Future: only flag on pages detected as multilingual
  // if (result.hreflang_tags is empty && page is multilingual) { ... }

  // Missing security headers
  if (result.security_headers) {
    const missingHeaders: string[] = [];
    const criticalHeaders: Record<string, string> = {
      "strict-transport-security": "HSTS (Strict-Transport-Security)",
      "x-content-type-options": "X-Content-Type-Options",
    };

    for (const [header, label] of Object.entries(criticalHeaders)) {
      if (!result.security_headers[header]) {
        missingHeaders.push(label);
      }
    }

    if (missingHeaders.length > 0) {
      addIssue(
        "missing_security_headers",
        "low",
        `Missing security headers: ${missingHeaders.join(", ")}`,
        {
          url: result.url,
          missing_headers: missingHeaders,
        },
      );
    }
  }

  // Redirect chain (3+ hops)
  if (result.redirect_chain && result.redirect_chain.length >= 3) {
    addIssue(
      "redirect_chain",
      "high",
      `Redirect chain has ${result.redirect_chain.length} hops, wasting crawl budget and slowing page load`,
      {
        url: result.url,
        chain: result.redirect_chain,
        hop_count: result.redirect_chain.length,
      },
    );
  }

  // Keyword not in title
  if (
    result.keywords &&
    result.keywords.length > 0 &&
    result.title &&
    result.title.trim().length > 0
  ) {
    const topKeyword = result.keywords[0].word.toLowerCase();
    const titleLower = result.title.toLowerCase();
    if (!titleLower.includes(topKeyword)) {
      addIssue(
        "keyword_not_in_title",
        "low",
        `Top keyword "${result.keywords[0].word}" does not appear in the page title`,
        {
          url: result.url,
          top_keyword: result.keywords[0].word,
          title: result.title,
        },
      );
    }
  }

  return issues;
}

/**
 * Guess image format from URL when no explicit format field is available.
 */
function guessFormatFromSrc(src: string): string {
  try {
    const pathname = new URL(src, "https://placeholder.local").pathname.toLowerCase();
    if (pathname.endsWith(".webp")) return "webp";
    if (pathname.endsWith(".avif")) return "avif";
    if (pathname.endsWith(".svg")) return "svg";
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpeg";
    if (pathname.endsWith(".gif")) return "gif";
    if (pathname.endsWith(".bmp")) return "bmp";
    if (pathname.endsWith(".ico")) return "ico";
  } catch {
    // Invalid URL — fall through
  }
  return "unknown";
}
