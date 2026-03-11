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
 * Clears all existing issues for the project before inserting new ones,
 * since each scan represents a fresh analysis of the entire site.
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

    // Step 4: Clear old issues for this project (fresh analysis per scan)
    const { error: deleteError } = await supabase
      .from("issues")
      .delete()
      .eq("project_id", projectId);

    if (deleteError) {
      console.error("Error clearing old issues:", deleteError);
      // Continue anyway -- inserting new issues is more important
    }

    // Step 5: Insert new issues in batches
    if (allIssues.length === 0) {
      console.log("No issues detected");
      return 0;
    }

    const batchSize = 50;
    let totalInserted = 0;

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
      } else {
        totalInserted += batch.length;
      }
    }

    console.log(
      `Issue detection complete: ${totalInserted} issues found for project ${projectId}`,
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

  return issues;
}
