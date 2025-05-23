import { ScanResult } from "../types";
import { Tables } from "../database.types";
import { getSupabaseClient, getSupabaseServiceClient } from "./database/client";

type Page = Tables<`pages`>;

/**
 * Store scan results in the database with deduplication, UPSERT, and cleanup
 */
export async function storeScanResults(
  projectId: string,
  scanId: string,
  results: ScanResult[],
): Promise<void> {
  const supabase = getSupabaseServiceClient();

  try {
    console.log(
      `Processing ${results.length} scan results for project ${projectId}`,
    );

    // STEP 1: Get existing pages for this project to track what needs cleanup
    const { data: existingPages, error: existingError } = await supabase
      .from("pages")
      .select("id, url")
      .eq("project_id", projectId);

    if (existingError) {
      console.error("Error fetching existing pages:", existingError);
      throw existingError;
    }

    const existingUrlSet = new Set(existingPages?.map((p) => p.url) || []);
    console.log(`📊 Found ${existingUrlSet.size} existing pages in database`);

    // STEP 2: Deduplicate results by URL (keep the first occurrence)
    const urlMap = new Map<string, ScanResult>();

    for (const result of results) {
      const normalizedUrl = result.url.toLowerCase().trim();
      if (!urlMap.has(normalizedUrl)) {
        urlMap.set(normalizedUrl, result);
      } else {
        console.log(`Duplicate URL found and skipped: ${result.url}`);
      }
    }

    const deduplicatedResults = Array.from(urlMap.values());
    console.log(`✅ Deduplicated to ${deduplicatedResults.length} unique URLs`);

    // STEP 3: Track which URLs are found in current scan
    const currentScanUrls = new Set(deduplicatedResults.map((r) => r.url));

    // STEP 4: Identify pages to remove (exist in DB but not in current scan)
    const urlsToRemove = Array.from(existingUrlSet).filter(
      (url) => !currentScanUrls.has(url),
    );

    if (urlsToRemove.length > 0) {
      console.log(
        `🧹 Found ${urlsToRemove.length} pages to remove that are no longer accessible:`,
      );
      urlsToRemove.forEach((url) => console.log(`  - ${url}`));

      // Remove old pages and their associated data
      await cleanupRemovedPages(supabase, projectId, urlsToRemove);
    } else {
      console.log(`✅ No pages need to be removed`);
    }

    // STEP 5: Prepare pages for upsert
    const pages = deduplicatedResults.map((result) => ({
      project_id: projectId,
      url: result.url,
      title: result.title,
      meta_description: result.meta_description,
      // meta_description_length: result.meta_description?.length || 0,
      // title_length: result.title?.length || 0,
      h1s: result.h1s,
      h2s: result.h2s,
      h3s: result.h3s,
      h4s: result.h4s,
      h5s: result.h5s,
      h6s: result.h6s,
      content_length: result.content_length,
      word_count: result.word_count,
      canonical_url: result.canonical_url,
      http_status: result.status,
      is_indexable: result.is_indexable,
      has_robots_noindex: result.has_robots_noindex,
      has_robots_nofollow: result.has_robots_nofollow,
      depth: result.depth,
      redirect_url: result.redirect_url,
      content_type: result.content_type,
      size_bytes: result.size_bytes,
      load_time_ms: result.load_time_ms,
      first_byte_time_ms: result.first_byte_time_ms,
      structured_data: result.structured_data,
      schema_types: result.schema_types,
      images: result.images,
      js_count: result.js_count,
      css_count: result.css_count,
      keywords: result.keywords,
      open_graph: result.open_graph,
      twitter_card: result.twitter_card,
      crawl_priority: result.depth === 0 ? 10 : Math.max(1, 10 - result.depth),
      updated_at: new Date().toISOString(),
    }));

    // STEP 6: Upsert pages in batches
    const batchSize = 50;
    let totalUpserted = 0;

    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);

      // Double-check for duplicates within this batch (extra safety)
      const batchUrls = new Set();
      const cleanBatch = batch.filter((page) => {
        if (batchUrls.has(page.url)) {
          console.log(`Skipping duplicate in batch: ${page.url}`);
          return false;
        }
        batchUrls.add(page.url);
        return true;
      });

      const { error: pagesError } = await supabase
        .from("pages")
        .upsert(cleanBatch, {
          onConflict: "project_id,url",
          ignoreDuplicates: false,
        });

      if (pagesError) {
        console.error("Error upserting pages batch:", pagesError);
        console.error(
          "Batch details:",
          cleanBatch.map((p) => p.url),
        );
        throw pagesError;
      }

      totalUpserted += cleanBatch.length;
      console.log(
        `Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
          pages.length / batchSize,
        )} (${cleanBatch.length} pages)`,
      );
    }

    console.log(`📝 Total pages upserted: ${totalUpserted}`);

    // STEP 7: Get all current pages for this project to create links mapping
    const { data: allPages, error: fetchError } = await supabase
      .from("pages")
      .select("id, url")
      .eq("project_id", projectId);

    if (fetchError) {
      console.error("Error fetching pages:", fetchError);
      throw fetchError;
    }

    // Create URL to ID mapping
    const urlToPageId = new Map(allPages?.map((p) => [p.url, p.id]) || []);

    // STEP 8: Clear existing links for this project to avoid duplicates
    console.log("🧹 Clearing existing links for project...");
    const { error: deleteLinksError } = await supabase
      .from("page_links")
      .delete()
      .eq("project_id", projectId);

    if (deleteLinksError) {
      console.error("Error clearing existing links:", deleteLinksError);
      // Continue without clearing - links might just duplicate
    }

    // STEP 9: Store links
    const allLinks: any[] = [];

    for (const result of deduplicatedResults) {
      const sourcePageId = urlToPageId.get(result.url);
      if (!sourcePageId) {
        console.log(`No page ID found for URL: ${result.url}`);
        continue;
      }

      // Internal links
      for (const link of result.internal_links) {
        const destinationPageId = urlToPageId.get(link.url);
        allLinks.push({
          project_id: projectId,
          source_page_id: sourcePageId,
          destination_page_id: destinationPageId,
          destination_url: link.url,
          anchor_text: link.anchor_text,
          link_type: "internal",
          rel_attributes: link.rel_attributes,
          is_followed: !link.rel_attributes?.includes("nofollow"),
          http_status: destinationPageId ? 200 : null, // Assume 200 if we have the page
          is_broken: !destinationPageId, // Mark as broken if destination page not found
        });
      }

      // External links
      for (const link of result.external_links) {
        allLinks.push({
          project_id: projectId,
          source_page_id: sourcePageId,
          destination_page_id: null,
          destination_url: link.url,
          anchor_text: link.anchor_text,
          link_type: "external",
          rel_attributes: link.rel_attributes,
          is_followed: !link.rel_attributes?.includes("nofollow"),
        });
      }
    }

    // STEP 10: Insert links in batches
    if (allLinks.length > 0) {
      console.log(`🔗 Inserting ${allLinks.length} links...`);

      for (let i = 0; i < allLinks.length; i += batchSize) {
        const batch = allLinks.slice(i, i + batchSize);
        const { error: linksError } = await supabase
          .from("page_links")
          .insert(batch);

        if (linksError) {
          console.error("Error inserting links batch:", linksError);
          // Don't throw - pages are more important than links
        }
      }
    }

    // STEP 11: Update scan summary with cleanup info
    const { error: scanUpdateError } = await supabase
      .from("scans")
      .update({
        summary_stats: {
          pages_found: totalUpserted,
          pages_removed: urlsToRemove.length,
          links_created: allLinks.length,
          cleanup_performed: urlsToRemove.length > 0,
        },
      })
      .eq("id", scanId);

    if (scanUpdateError) {
      console.error("Error updating scan summary:", scanUpdateError);
    }

    console.log(
      `✅ Successfully processed project ${projectId}: ${totalUpserted} pages upserted, ${urlsToRemove.length} pages removed, ${allLinks.length} links created`,
    );
  } catch (error) {
    console.error("❌ Error storing scan results:", error);
    throw error;
  }
}

/**
 * Clean up pages that are no longer accessible and their associated data
 */
async function cleanupRemovedPages(
  supabase: any,
  projectId: string,
  urlsToRemove: string[],
): Promise<void> {
  try {
    // Get page IDs for the URLs to remove
    const { data: pagesToRemove, error: fetchError } = await supabase
      .from("pages")
      .select("id, url")
      .eq("project_id", projectId)
      .in("url", urlsToRemove);

    if (fetchError) {
      console.error("Error fetching pages to remove:", fetchError);
      return;
    }

    if (!pagesToRemove || pagesToRemove.length === 0) {
      console.log("No pages found to remove");
      return;
    }

    const pageIdsToRemove = pagesToRemove.map((p: Page) => p.id);

    // Remove associated data in correct order (foreign key constraints)

    // 1. Remove page links (both source and destination)
    const { error: linksError } = await supabase
      .from("page_links")
      .delete()
      .or(
        `source_page_id.in.(${pageIdsToRemove.join(
          ",",
        )}),destination_page_id.in.(${pageIdsToRemove.join(",")})`,
      );

    if (linksError) {
      console.error("Error removing page links:", linksError);
    }

    // 2. Remove issues associated with these pages
    const { error: issuesError } = await supabase
      .from("issues")
      .delete()
      .in("page_id", pageIdsToRemove);

    if (issuesError) {
      console.error("Error removing page issues:", issuesError);
    }

    // 3. Remove backlinks to these pages
    const { error: backlinksError } = await supabase
      .from("backlinks")
      .delete()
      .in("page_id", pageIdsToRemove);

    if (backlinksError) {
      console.error("Error removing backlinks:", backlinksError);
    }

    // 4. Finally, remove the pages themselves
    const { error: pagesError } = await supabase
      .from("pages")
      .delete()
      .in("id", pageIdsToRemove);

    if (pagesError) {
      console.error("Error removing pages:", pagesError);
      throw pagesError;
    }

    console.log(
      `🧹 Successfully cleaned up ${pagesToRemove.length} removed pages and their associated data`,
    );
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
    throw error;
  }
}

/**
 * Get scan results from database
 */
export async function getScanResults(
  projectId: string,
  scanId?: string,
): Promise<{ pages: any[]; links: any[] }> {
  const supabase = getSupabaseClient();

  try {
    // Get pages
    let pagesQuery = supabase
      .from("pages")
      .select("*")
      .eq("project_id", projectId)
      .order("crawl_priority", { ascending: false });

    const { data: pages, error: pagesError } = await pagesQuery;

    if (pagesError) {
      throw pagesError;
    }

    // Get links
    const { data: links, error: linksError } = await supabase
      .from("page_links")
      .select("*")
      .eq("project_id", projectId);

    if (linksError) {
      throw linksError;
    }

    return {
      pages: pages || [],
      links: links || [],
    };
  } catch (error) {
    console.error("Error fetching scan results:", error);
    throw error;
  }
}
