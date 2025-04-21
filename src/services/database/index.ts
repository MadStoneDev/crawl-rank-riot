import { getSupabaseClient } from "./client";
import { ScanResult } from "../../types/common";

/**
 * Main function to store scan results in the database
 * @param projectId Project ID
 * @param scanId Scan ID
 * @param scanResults Scan results to store
 * @returns Operation success status
 */
export async function storeScanResults(
  projectId: string,
  scanId: string,
  scanResults: ScanResult[],
): Promise<{ success: boolean }> {
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] Storing scan results for project ${projectId}, scan ${scanId}`,
  );
  console.log(`[${timestamp}] Processing ${scanResults.length} pages...`);

  try {
    const supabase = getSupabaseClient();

    // Map to track URL to page ID
    const urlToPageId: Record<string, string> = {};

    // 1. Store all pages first
    for (const page of scanResults) {
      const pageId = await storePageData(projectId, page, scanResults);
      if (pageId) {
        urlToPageId[page.url] = pageId;
      }
    }

    // 2. Process links (need to have all pages stored first to create proper relationships)
    console.log(
      `[${timestamp}] Processing links for ${scanResults.length} pages`,
    );
    for (const page of scanResults) {
      const sourcePageId = urlToPageId[page.url];
      if (!sourcePageId) {
        console.warn(`[${timestamp}] No page ID found for URL: ${page.url}`);
        continue;
      }

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

    // 3. Identify potential issues and create records
    console.log(
      `[${timestamp}] Detecting issues for ${scanResults.length} pages`,
    );
    let issuesCount = 0;
    for (const page of scanResults) {
      const pageId = urlToPageId[page.url];
      if (pageId) {
        const pageIssuesCount = await detectAndStoreIssues(
          projectId,
          scanId,
          pageId,
          page,
        );
        issuesCount += pageIssuesCount;
      }
    }

    // 4. Store a snapshot of the entire scan results
    console.log(`[${timestamp}] Creating scan snapshot for scan ${scanId}`);
    await createScanSnapshot(scanId, scanResults);

    // 5. Update scan record with completion details
    console.log(`[${timestamp}] Updating scan record with completion details`);
    await updateScanRecord(scanId, scanResults, issuesCount);

    console.log(
      `[${timestamp}] Successfully stored scan results for project ${projectId}`,
    );
    return { success: true };
  } catch (error) {
    console.error(`[${timestamp}] Error storing scan results:`, error);
    throw error;
  }
}

/**
 * Store page data in the pages table
 * @param projectId Project ID
 * @param page Page data to store
 * @param scanResults
 * @returns Page ID if successful, null otherwise
 */
async function storePageData(
  projectId: string,
  page: ScanResult,
  scanResults: ScanResult[],
): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();

    // If this is the first page in the scan, flush existing pages
    if (page.url === scanResults[0].url) {
      const { error: deleteError } = await supabase
        .from("pages")
        .delete()
        .eq("project_id", projectId);
      if (deleteError) {
        console.error(
          `[DEBUG] Error deleting existing pages for project ${projectId}:`,
          deleteError,
        );
      }
    }

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
        http_status: page.status,
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
 * Create a snapshot of the entire scan in scan_snapshots
 * @param scanId Scan ID
 * @param scanResults Scan results to snapshot
 */
async function createScanSnapshot(
  scanId: string,
  scanResults: ScanResult[],
): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await (supabase.from("scan_snapshots") as any).insert({
      scan_id: scanId,
      snapshot_data: scanResults, // Store the entire scan results array
    });

    if (error) {
      console.error(`Error creating scan snapshot for scan ${scanId}:`, error);
    } else {
      console.log(`Successfully created snapshot for scan ${scanId}`);
    }
  } catch (error) {
    console.error(`Error in createScanSnapshot for ${scanId}:`, error);
  }
}

/**
 * Store page links in the page_links table
 * @param projectId Project ID
 * @param sourcePageId Source page ID
 * @param links Links to store
 * @param urlToPageId Map of URLs to page IDs
 * @param linkType Link type (internal or external)
 */
async function storePageLinks(
  projectId: string,
  sourcePageId: string,
  links: Array<{
    url: string;
    anchor_text: string;
    rel_attributes: string[];
  }>,
  urlToPageId: Record<string, string>,
  linkType: "internal" | "external",
): Promise<void> {
  const supabase = getSupabaseClient();

  // Filter out duplicate links within the batch
  const uniqueLinks = Array.from(
    new Map(links.map((link) => [link.url, link])).values(),
  );

  // Process in batches to avoid hitting rate limits
  const batchSize = 50;

  for (let i = 0; i < uniqueLinks.length; i += batchSize) {
    const batch = uniqueLinks.slice(i, i + batchSize);

    const linksToInsert = batch
      .map((link) => {
        // Sanitize URL
        const sanitizedUrl = link.url.trim();

        // For internal links, we might have a destination page ID
        const destinationPageId =
          linkType === "internal" ? urlToPageId[sanitizedUrl] : null;

        return {
          project_id: projectId,
          source_page_id: sourcePageId,
          destination_url: sanitizedUrl,
          destination_page_id: destinationPageId,
          anchor_text: link.anchor_text?.trim() || "",
          link_type: linkType,
          is_followed: !link.rel_attributes?.includes("nofollow"),
          rel_attributes: link.rel_attributes || [],
        };
      })
      .filter((link) => link.destination_url); // Remove any links with empty URLs

    if (linksToInsert.length > 0) {
      try {
        const { error, data } = await (
          supabase.from("page_links") as any
        ).upsert(linksToInsert, {
          onConflict: "source_page_id, destination_url",
          returning: "minimal", // Reduce payload size
        });

        if (error) {
          console.error(`Error storing ${linkType} links batch:`, {
            error,
            batchSize: linksToInsert.length,
            sourcePageId,
            projectId,
          });
        } else {
          console.log(
            `Successfully stored ${linksToInsert.length} ${linkType} links`,
          );
        }
      } catch (error) {
        console.error(
          `Unexpected error in storePageLinks for ${linkType} batch:`,
          {
            error,
            batchSize: linksToInsert.length,
            sourcePageId,
            projectId,
          },
        );
      }
    }
  }
}

/**
 * Detect and store issues found on the page
 * @param projectId Project ID
 * @param scanId Scan ID
 * @param pageId Page ID
 * @param page Page data
 * @returns Number of issues found
 */
async function detectAndStoreIssues(
  projectId: string,
  scanId: string,
  pageId: string,
  page: ScanResult,
): Promise<number> {
  const supabase = getSupabaseClient();
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
  const imagesWithoutAlt = page.images.filter(
    (img) => !img.alt || img.alt.trim() === "",
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
 * @param scanId Scan ID
 * @param scanResults Scan results
 * @param issuesCount Number of issues found
 */
async function updateScanRecord(
  scanId: string,
  scanResults: ScanResult[],
  issuesCount: number = 0,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    console.log(`[DEBUG] Updating scan record: 
      ScanID: ${scanId}
      Total Pages: ${scanResults.length}
      Issues Count: ${issuesCount}
      Timestamp: ${new Date().toISOString()}
    `);

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
    const { data, error } = await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        pages_scanned: scanResults.length,
        links_scanned: totalInternalLinks + totalExternalLinks,
        issues_found: issuesCount,
        summary_stats: summaryStats,
      })
      .eq("id", scanId)
      .select();

    if (error) {
      console.error(`Error updating scan record ${scanId}:`, error);
    } else {
      console.log(`[DEBUG] Scan record updated successfully:`, data);
    }
  } catch (error) {
    console.error(`Error in updateScanRecord for ${scanId}:`, error);
  }
}

/**
 * Count HTTP statuses from scan results
 * @param pages Scan results
 * @returns Map of status codes to counts
 */
function countHttpStatuses(pages: ScanResult[]): Record<string, number> {
  const counts: Record<string, number> = {};

  pages.forEach((page) => {
    const status = page.status.toString();
    counts[status] = (counts[status] || 0) + 1;
  });

  return counts;
}

/**
 * Calculate average for a property across scan results
 * @param pages Scan results
 * @param property Property to average
 * @returns Average value
 */
function calculateAverage(
  pages: ScanResult[],
  property: keyof ScanResult,
): number {
  if (pages.length === 0) return 0;

  const validPages = pages.filter((page) => typeof page[property] === "number");
  if (validPages.length === 0) return 0;

  const sum = validPages.reduce((total, page) => {
    const value = page[property];
    return total + (typeof value === "number" ? value : 0);
  }, 0);

  return Math.round(sum / validPages.length);
}
