import { ScanResult } from "../types";
import { getSupabaseClient, getSupabaseServiceClient } from "./database/client";

/**
 * Store scan results in the database
 */
export async function storeScanResults(
  projectId: string,
  scanId: string,
  results: ScanResult[],
): Promise<void> {
  const supabase = getSupabaseServiceClient();

  try {
    // Store pages
    const pages = results.map((result) => ({
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
      // REMOVED: title_length and meta_description_length (generated columns)
      // These are automatically calculated by the database:
      // - title_length = COALESCE(length(title), 0)
      // - meta_description_length = COALESCE(length(meta_description), 0)
      crawl_priority: result.depth === 0 ? 10 : Math.max(1, 10 - result.depth),
    }));

    // Insert pages in batches
    const batchSize = 100;
    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize);
      const { error: pagesError } = await supabase.from("pages").insert(batch);

      if (pagesError) {
        console.error("Error inserting pages batch:", pagesError);
        throw pagesError;
      }
    }

    // Get inserted pages to create links
    const { data: insertedPages, error: fetchError } = await supabase
      .from("pages")
      .select("id, url")
      .eq("project_id", projectId)
      .in(
        "url",
        results.map((r) => r.url),
      );

    if (fetchError) {
      console.error("Error fetching inserted pages:", fetchError);
      throw fetchError;
    }

    // Create URL to ID mapping
    const urlToPageId = new Map(insertedPages?.map((p) => [p.url, p.id]) || []);

    // Store links
    const allLinks: any[] = [];

    for (const result of results) {
      const sourcePageId = urlToPageId.get(result.url);
      if (!sourcePageId) continue;

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
          is_followed: !link.rel_attributes.includes("nofollow"),
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
          is_followed: !link.rel_attributes.includes("nofollow"),
        });
      }
    }

    // Insert links in batches
    if (allLinks.length > 0) {
      for (let i = 0; i < allLinks.length; i += batchSize) {
        const batch = allLinks.slice(i, i + batchSize);
        const { error: linksError } = await supabase
          .from("page_links")
          .insert(batch);

        if (linksError) {
          console.error("Error inserting links batch:", linksError);
          // Don't throw here, as pages are already stored
        }
      }
    }

    console.log(
      `Successfully stored ${results.length} pages and ${allLinks.length} links`,
    );
  } catch (error) {
    console.error("Error storing scan results:", error);
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
