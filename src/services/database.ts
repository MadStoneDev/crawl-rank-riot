import { ScanResult } from "../types";
import { getSupabaseClient, getSupabaseServiceClient } from "./database/client";

/**
 * Store scan results in the database with deduplication and UPSERT
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

    // STEP 1: Deduplicate results by URL (keep the first occurrence)
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
    console.log(`Deduplicated to ${deduplicatedResults.length} unique URLs`);

    // STEP 2: Prepare pages for upsert
    const pages = deduplicatedResults.map((result) => ({
      project_id: projectId,
      url: result.url,
      title: result.title,
      meta_description: result.meta_description,
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

    // STEP 3: Upsert pages in batches
    const batchSize = 50; // Smaller batches to avoid issues
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

    console.log(`Total pages upserted: ${totalUpserted}`);

    // STEP 4: Get all pages for this project to create links mapping
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

    // STEP 5: Clear existing links for this project to avoid duplicates
    console.log("Clearing existing links for project...");
    const { error: deleteLinksError } = await supabase
      .from("page_links")
      .delete()
      .eq("project_id", projectId);

    if (deleteLinksError) {
      console.error("Error clearing existing links:", deleteLinksError);
      // Continue without clearing - links might just duplicate
    }

    // STEP 6: Store links
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

    // STEP 7: Insert links in batches
    if (allLinks.length > 0) {
      console.log(`Inserting ${allLinks.length} links...`);

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

    console.log(
      `✅ Successfully stored ${totalUpserted} pages and ${allLinks.length} links for project ${projectId}`,
    );
  } catch (error) {
    console.error("❌ Error storing scan results:", error);
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
      .eq("project_id", projectId);

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
