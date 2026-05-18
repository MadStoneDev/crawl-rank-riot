import { ScanResult } from "../types";
import { Tables } from "../database.types";
import { getSupabaseServiceClient } from "./database/client";

type Page = Tables<`pages`>;

/**
 * Store scan results in the database with deduplication, UPSERT, and cleanup
 */
export async function storeScanResults(
  projectId: string,
  scanId: string,
  results: ScanResult[],
  options: { crawlCompleted?: boolean } = {},
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

    // STEP 1.5: Proactively remove any bogus pages from older scans
    const bogusPages = (existingPages || []).filter(
      (p) =>
        !/^https?:\/\//i.test(p.url) ||
        /^https?:\/\/(mailto|tel|javascript|sms|ftp):/i.test(p.url),
    );
    if (bogusPages.length > 0) {
      console.log(
        `🧹 Removing ${bogusPages.length} bogus pages (mailto:, tel:, mangled URLs, etc.)`,
      );
      await cleanupRemovedPages(
        supabase,
        projectId,
        bogusPages.map((p) => p.url),
      );
      bogusPages.forEach((p) => existingUrlSet.delete(p.url));
    }

    // STEP 2: Deduplicate results by URL (keep the first occurrence)
    const urlMap = new Map<string, ScanResult>();

    for (const result of results) {
      // Skip non-HTTP URLs that should never be stored as pages
      if (!/^https?:\/\//i.test(result.url)) {
        console.log(`Skipping non-HTTP URL: ${result.url}`);
        continue;
      }
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
    // Only remove pages if the crawl completed fully — partial crawls (timeout)
    // would incorrectly delete pages that simply weren't reached
    let urlsToRemove: string[] = [];
    if (options.crawlCompleted) {
      urlsToRemove = Array.from(existingUrlSet).filter(
        (url) => !currentScanUrls.has(url),
      );

      if (urlsToRemove.length > 0) {
        console.log(
          `🧹 Found ${urlsToRemove.length} pages to remove that are no longer accessible:`,
        );
        urlsToRemove.forEach((url) => console.log(`  - ${url}`));

        await cleanupRemovedPages(supabase, projectId, urlsToRemove);
      } else {
        console.log(`✅ No pages need to be removed`);
      }
    } else {
      console.log(
        `⏭️ Skipping page cleanup — crawl may not have completed fully`,
      );
    }

    // STEP 5: Prepare pages for upsert
    const pages = deduplicatedResults.map((result) => ({
      project_id: projectId,
      url: result.url,
      title: result.title,
      meta_description: result.meta_description,
      meta_description_length: result.meta_description?.length || 0,
      title_length: result.title?.length || 0,
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
      security_headers: result.security_headers || null,
      redirect_chain: result.redirect_chain || null,
      has_viewport_meta: result.has_viewport_meta ?? null,
      has_mixed_content: result.has_mixed_content ?? null,
      heading_hierarchy_valid: result.heading_hierarchy_valid ?? null,
      heading_hierarchy_issues: result.heading_hierarchy_issues || null,
      hreflang_tags: result.hreflang_tags || null,
      canonical_is_self: result.canonical_is_self ?? null,
      url_issues: result.url_issues || null,
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

    // Create URL to ID mapping (case-insensitive, with trailing slash variants)
    const urlToPageId = new Map<string, string>();
    for (const p of allPages || []) {
      urlToPageId.set(p.url, p.id);
      urlToPageId.set(p.url.toLowerCase(), p.id);
      // Also map with/without trailing slash
      if (p.url.endsWith("/")) {
        urlToPageId.set(p.url.slice(0, -1), p.id);
        urlToPageId.set(p.url.slice(0, -1).toLowerCase(), p.id);
      } else {
        urlToPageId.set(p.url + "/", p.id);
        urlToPageId.set((p.url + "/").toLowerCase(), p.id);
      }
    }

    // STEP 8: Build links array FIRST (before clearing old ones)
    const allLinks: any[] = [];

    for (const result of deduplicatedResults) {
      const sourcePageId = urlToPageId.get(result.url);
      if (!sourcePageId) {
        console.log(`No page ID found for URL: ${result.url}`);
        continue;
      }

      // Internal links
      for (const link of result.internal_links) {
        // Skip non-HTTP URLs that may have slipped through extraction
        if (!/^https?:\/\//i.test(link.url)) continue;
        const destinationPageId = urlToPageId.get(link.url)
          || urlToPageId.get(link.url.toLowerCase());

        // Look up the destination page's status if it was crawled
        let httpStatus: number | null = null;
        let isBroken = false;

        if (destinationPageId) {
          const destResult = deduplicatedResults.find(r => r.url === link.url);
          if (destResult) {
            httpStatus = destResult.status;
            isBroken = destResult.status >= 400;
          } else {
            httpStatus = 200;
            isBroken = false;
          }
        } else {
          httpStatus = null;
          isBroken = false;
        }

        allLinks.push({
          project_id: projectId,
          source_page_id: sourcePageId,
          destination_page_id: destinationPageId,
          destination_url: link.url,
          anchor_text: link.anchor_text,
          link_type: "internal",
          rel_attributes: link.rel_attributes,
          is_followed: !link.rel_attributes?.includes("nofollow"),
          http_status: httpStatus,
          is_broken: isBroken,
        });
      }

      // External links - mark as unchecked (not broken)
      for (const link of result.external_links) {
        // Skip non-HTTP URLs that may have slipped through extraction
        if (!/^https?:\/\//i.test(link.url)) continue;
        allLinks.push({
          project_id: projectId,
          source_page_id: sourcePageId,
          destination_page_id: null,
          destination_url: link.url,
          anchor_text: link.anchor_text,
          link_type: "external",
          rel_attributes: link.rel_attributes,
          is_followed: !link.rel_attributes?.includes("nofollow"),
          http_status: null,
          is_broken: false,
        });
      }
    }

    // STEP 9: Only clear and re-insert links if we have new ones to store
    // This prevents data loss if something fails during processing
    if (allLinks.length > 0) {
      console.log(`🔗 Replacing links: clearing old, inserting ${allLinks.length} new...`);

      const { error: deleteLinksError } = await supabase
        .from("page_links")
        .delete()
        .eq("project_id", projectId);

      if (deleteLinksError) {
        console.error("Error clearing existing links:", deleteLinksError);
      }

      for (let i = 0; i < allLinks.length; i += batchSize) {
        const batch = allLinks.slice(i, i + batchSize);
        const { error: linksError } = await supabase
          .from("page_links")
          .insert(batch);

        if (linksError) {
          console.error("Error inserting links batch:", linksError);
        }
      }
    } else {
      console.log(`⚠️ No links built from scan results — keeping existing links intact`);
    }

    // STEP 10: Update scan summary with cleanup info
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
  const supabase = getSupabaseServiceClient();

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
