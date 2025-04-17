import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Load environment variables
dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Error: Missing required environment variables for Supabase connection",
  );
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Main function to store scan results in the database
 */
export async function storeScanResults(
  projectId: string,
  scanId: string,
  scanResults: any[],
) {
  try {
    console.log(
      `Storing scan results for project ${projectId}, scan ${scanId}`,
    );
    console.log(`Processing ${scanResults.length} pages...`);

    // Map to track URL to page ID
    const urlToPageId: Record<string, string> = {};

    // 1. Store all pages first
    for (const page of scanResults) {
      const pageId = await storePageData(projectId, page);
      if (pageId) {
        urlToPageId[page.url] = pageId;

        // 2. Create a snapshot for this page
        await createPageSnapshot(scanId, pageId, page);
      }
    }

    // 3. Process links (need to have all pages stored first to create proper relationships)
    for (const page of scanResults) {
      const sourcePageId = urlToPageId[page.url];
      if (!sourcePageId) continue;

      // Store internal links
      await storePageLinks(
        projectId,
        sourcePageId,
        page.internal_links,
        urlToPageId,
        "internal",
      );

      // Store external links
      await storePageLinks(
        projectId,
        sourcePageId,
        page.external_links,
        urlToPageId,
        "external",
      );
    }

    // 4. Identify potential issues and create records
    for (const page of scanResults) {
      const pageId = urlToPageId[page.url];
      if (pageId) {
        await detectAndStoreIssues(projectId, scanId, pageId, page);
      }
    }

    // 5. Update scan record with completion details
    await updateScanRecord(scanId, scanResults);

    console.log(`Successfully stored scan results for project ${projectId}`);
    return { success: true };
  } catch (error) {
    console.error("Error storing scan results:", error);
    throw error;
  }
}

/**
 * Store page data in the pages table
 */
async function storePageData(
  projectId: string,
  page: any,
): Promise<string | null> {
  try {
    // First, upsert the data
    const { error } = await supabase.from("pages").upsert(
      {
        project_id: projectId,
        url: page.url,
        title: page.title,
        meta_description: page.meta_description,
        h1s: page.h1s,
        h2s: page.h2s,
        h3s: page.h3s,
        h4s: page.h4s,
        h5s: page.h5s,
        h6s: page.h6s,
        content_length: page.content_length,
        word_count: page.word_count,
        open_graph: page.open_graph,
        twitter_card: page.twitter_card,
        canonical_url: page.canonical_url,
        http_status: page.http_status,
        is_indexable: page.is_indexable,
        has_robots_noindex: page.has_robots_noindex,
        has_robots_nofollow: page.has_robots_nofollow,
        depth: page.depth,
        redirect_url: page.redirect_url,
        content_type: page.content_type,
        size_bytes: page.size_bytes,
        load_time_ms: page.load_time_ms,
        first_byte_time_ms: page.first_byte_time_ms,
        structured_data: page.structured_data,
        schema_types: page.schema_types,
        images: page.images,
        keywords: page.keywords,
        js_count: page.js_count,
        css_count: page.css_count,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "project_id, url",
      },
    );

    if (error) {
      console.error(`Error storing page ${page.url}:`, error);
      return null;
    }

    // Then query to get the ID
    const { data: pageData, error: selectError } = await supabase
      .from("pages")
      .select("id")
      .eq("project_id", projectId)
      .eq("url", page.url)
      .single();

    if (selectError) {
      console.error(`Error retrieving page ID for ${page.url}:`, selectError);
      return null;
    }

    return pageData.id;
  } catch (error) {
    console.error(`Error in storePageData for ${page.url}:`, error);
    return null;
  }
}

/**
 * Create a snapshot of the page in scan_page_snapshots
 */
async function createPageSnapshot(scanId: string, pageId: string, page: any) {
  try {
    const { error } = await supabase.from("scan_page_snapshots").insert({
      scan_id: scanId,
      page_id: pageId,
      url: page.url,
      title: page.title,
      meta_description: page.meta_description,
      h1s: page.h1s,
      h2s: page.h2s,
      h3s: page.h3s,
      h4s: page.h4s,
      h5s: page.h5s,
      h6s: page.h6s,
      content_length: page.content_length,
      http_status: page.http_status,
      is_indexable: page.is_indexable,
      snapshot_data: page, // Store the entire page data as JSON
    });

    if (error) {
      console.error(`Error creating snapshot for page ${page.url}:`, error);
    }
  } catch (error) {
    console.error(`Error in createPageSnapshot for ${page.url}:`, error);
  }
}

/**
 * Store page links in the page_links table
 */
async function storePageLinks(
  projectId: string,
  sourcePageId: string,
  links: Array<{ url: string; anchor_text: string; rel_attributes: string[] }>,
  urlToPageId: Record<string, string>,
  linkType: "internal" | "external",
) {
  // Process in batches to avoid hitting rate limits
  const batchSize = 50;

  for (let i = 0; i < links.length; i += batchSize) {
    const batch = links.slice(i, i + batchSize);

    const linksToInsert = batch.map((link) => {
      // For internal links, we might have a destination page ID
      const destinationPageId =
        linkType === "internal" ? urlToPageId[link.url] : null;

      return {
        project_id: projectId,
        source_page_id: sourcePageId,
        destination_url: link.url,
        destination_page_id: destinationPageId,
        anchor_text: link.anchor_text,
        link_type: linkType,
        is_followed: !link.rel_attributes.includes("nofollow"),
        rel_attributes: link.rel_attributes,
      };
    });

    if (linksToInsert.length > 0) {
      try {
        const { error } = await supabase
          .from("page_links")
          .upsert(linksToInsert, {
            onConflict: "source_page_id, destination_url",
          });

        if (error) {
          console.error(`Error storing ${linkType} links batch:`, error);
        }
      } catch (error) {
        console.error(`Error in storePageLinks for ${linkType} batch:`, error);
      }
    }
  }
}

/**
 * Detect and store issues found on the page
 */
async function detectAndStoreIssues(
  projectId: string,
  scanId: string,
  pageId: string,
  page: any,
) {
  const issues = [];

  // Check for missing title
  if (!page.title || page.title.trim() === "") {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "missing_title",
      severity: "high",
      description: "Page is missing a title tag",
      details: { url: page.url },
    });
  }

  // Check for missing meta description
  if (!page.meta_description || page.meta_description.trim() === "") {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "missing_meta_description",
      severity: "medium",
      description: "Page is missing a meta description",
      details: { url: page.url },
    });
  }

  // Check for title length (too short or too long)
  if (page.title) {
    const titleLength = page.title.length;
    if (titleLength < 30) {
      issues.push({
        project_id: projectId,
        scan_id: scanId,
        page_id: pageId,
        issue_type: "title_too_short",
        severity: "medium",
        description: "Page title is too short (less than 30 characters)",
        details: { url: page.url, title: page.title, length: titleLength },
      });
    } else if (titleLength > 60) {
      issues.push({
        project_id: projectId,
        scan_id: scanId,
        page_id: pageId,
        issue_type: "title_too_long",
        severity: "low",
        description: "Page title is too long (more than 60 characters)",
        details: { url: page.url, title: page.title, length: titleLength },
      });
    }
  }

  // Check for meta description length
  if (page.meta_description) {
    const descLength = page.meta_description.length;
    if (descLength < 70) {
      issues.push({
        project_id: projectId,
        scan_id: scanId,
        page_id: pageId,
        issue_type: "meta_description_too_short",
        severity: "medium",
        description: "Meta description is too short (less than 70 characters)",
        details: {
          url: page.url,
          description: page.meta_description,
          length: descLength,
        },
      });
    } else if (descLength > 160) {
      issues.push({
        project_id: projectId,
        scan_id: scanId,
        page_id: pageId,
        issue_type: "meta_description_too_long",
        severity: "low",
        description: "Meta description is too long (more than 160 characters)",
        details: {
          url: page.url,
          description: page.meta_description,
          length: descLength,
        },
      });
    }
  }

  // Check for missing H1
  if (!page.h1s || page.h1s.length === 0) {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "missing_h1",
      severity: "medium",
      description: "Page does not have an H1 heading",
      details: { url: page.url },
    });
  }

  // Check for multiple H1s
  if (page.h1s && page.h1s.length > 1) {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "multiple_h1",
      severity: "medium",
      description: "Page has multiple H1 headings",
      details: { url: page.url, h1s: page.h1s },
    });
  }

  // Check for low content (thin content)
  if (page.word_count < 300) {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "thin_content",
      severity: "medium",
      description: "Page has thin content (less than 300 words)",
      details: { url: page.url, word_count: page.word_count },
    });
  }

  // Check for missing images alt text
  const imagesWithoutAlt = page.images?.filter(
    (img: { alt: string }) => !img.alt || img.alt.trim() === "",
  );
  if (imagesWithoutAlt && imagesWithoutAlt.length > 0) {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "images_missing_alt",
      severity: "medium",
      description: `Page has ${imagesWithoutAlt.length} images without alt text`,
      details: { url: page.url, images: imagesWithoutAlt },
    });
  }

  // Check if page is not indexable
  if (page.has_robots_noindex) {
    issues.push({
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: "page_noindex",
      severity: "info",
      description: "Page is set to noindex",
      details: { url: page.url },
    });
  }

  // Insert all issues
  if (issues.length > 0) {
    try {
      const { error } = await supabase.from("issues").insert(issues);
      if (error) {
        console.error(`Error storing issues for page ${page.url}:`, error);
      }
    } catch (error) {
      console.error(`Error in detectAndStoreIssues for ${page.url}:`, error);
    }
  }

  return issues.length;
}

/**
 * Update the scan record with completion details
 */
async function updateScanRecord(scanId: string, scanResults: any[]) {
  try {
    // Count total issues
    const { count } = await supabase
      .from("issues")
      .select("*", { count: "exact", head: true })
      .eq("scan_id", scanId);

    const issuesCount = count || 0;

    // Calculate total links
    const totalInternalLinks = scanResults.reduce(
      (sum, page) => sum + page.internal_links.length,
      0,
    );
    const totalExternalLinks = scanResults.reduce(
      (sum, page) => sum + page.external_links.length,
      0,
    );

    // Generate summary statistics
    const summaryStats = {
      http_status_counts: countHttpStatuses(scanResults),
      indexable_pages: scanResults.filter((page) => page.is_indexable).length,
      non_indexable_pages: scanResults.filter((page) => !page.is_indexable)
        .length,
      avg_page_load_time: calculateAverage(scanResults, "load_time_ms"),
      avg_word_count: calculateAverage(scanResults, "word_count"),
      total_internal_links: totalInternalLinks,
      total_external_links: totalExternalLinks,
    };

    // Update the scan record
    const { error } = await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        pages_scanned: scanResults.length,
        links_scanned: totalInternalLinks + totalExternalLinks,
        issues_found: issuesCount,
        summary_stats: summaryStats,
      })
      .eq("id", scanId);

    if (error) {
      console.error(`Error updating scan record ${scanId}:`, error);
    }
  } catch (error) {
    console.error(`Error in updateScanRecord for ${scanId}:`, error);
  }
}

// Helper function to count HTTP statuses
function countHttpStatuses(pages: any[]) {
  const counts: Record<string, number> = {};
  pages.forEach((page) => {
    const status = page.http_status.toString();
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

// Helper function to calculate average for a property
function calculateAverage(pages: any[], property: string) {
  if (pages.length === 0) return 0;
  const sum = pages.reduce((total, page) => total + (page[property] || 0), 0);
  return Math.round(sum / pages.length);
}

// Regarding backlinks:
/**
 * Note on backlinks vs page_links:
 *
 * - page_links table: stores links found on pages of your website (both internal and external)
 *   These are discovered during crawling your own site.
 *
 * - backlinks table: stores links from other websites that point to your website
 *   These are typically discovered through separate tools or APIs (like Ahrefs, Moz, etc.)
 *
 * To populate the backlinks table, you would need to:
 * 1. Use a separate API to discover backlinks to your site
 * 2. Run a separate crawler that visits those external sites and confirms the links
 * 3. Store the external->your site links in the backlinks table
 */
