import { getSupabaseServiceClient } from "./database/client";

interface ExternalLink {
  source_page_id: string;
  destination_url: string;
  anchor_text: string | null;
}

interface DiscoveredBacklink {
  project_id: string;
  page_id: string | null;
  source_url: string;
  source_domain: string;
  anchor_text: string | null;
  is_followed: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * Check external pages that link TO our project for backlinks.
 *
 * Strategy: take unique external domains found during the crawl,
 * fetch each external page, and look for links pointing back to
 * the project's domain. Store any matches in the backlinks table.
 *
 * This is a best-effort discovery — it only finds backlinks from
 * pages that the project itself links to externally.
 */
export async function checkAndStoreBacklinks(
  projectId: string,
  projectUrl: string,
): Promise<number> {
  const supabase = getSupabaseServiceClient();

  try {
    // Parse the project domain for matching
    const projectDomain = new URL(projectUrl).hostname.replace(/^www\./, "");

    // Fetch external links for this project (deduplicated by destination URL)
    const { data: externalLinks, error: linksError } = await supabase
      .from("page_links")
      .select("source_page_id, destination_url, anchor_text")
      .eq("project_id", projectId)
      .eq("link_type", "external");

    if (linksError) {
      console.error("Error fetching external links for backlink check:", linksError);
      return 0;
    }

    if (!externalLinks || externalLinks.length === 0) {
      console.log("No external links found — skipping backlink check");
      return 0;
    }

    // Deduplicate by destination URL — only check each external page once
    const uniqueUrls = new Map<string, ExternalLink>();
    for (const link of externalLinks) {
      if (!uniqueUrls.has(link.destination_url)) {
        uniqueUrls.set(link.destination_url, link);
      }
    }

    // Cap to avoid hammering external sites — check up to 100 unique URLs
    const urlsToCheck = Array.from(uniqueUrls.values()).slice(0, 100);
    console.log(
      `Backlink check: scanning ${urlsToCheck.length} external URLs for links back to ${projectDomain}`,
    );

    // Get page ID map (url → id) for the project so we can link backlinks to pages
    const { data: projectPages } = await supabase
      .from("pages")
      .select("id, url")
      .eq("project_id", projectId);

    const pageUrlToId = new Map<string, string>();
    for (const page of projectPages ?? []) {
      pageUrlToId.set(page.url, page.id);
      // Also store without trailing slash for flexible matching
      const withoutSlash = page.url.replace(/\/$/, "");
      const withSlash = page.url.endsWith("/") ? page.url : page.url + "/";
      pageUrlToId.set(withoutSlash, page.id);
      pageUrlToId.set(withSlash, page.id);
    }

    const discovered: DiscoveredBacklink[] = [];
    const now = new Date().toISOString();

    // Check external pages in batches of 5 concurrent requests
    const batchSize = 5;
    for (let i = 0; i < urlsToCheck.length; i += batchSize) {
      const batch = urlsToCheck.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((link) =>
          fetchAndFindBacklinks(link.destination_url, projectDomain, pageUrlToId),
        ),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value.length > 0) {
          for (const bl of result.value) {
            discovered.push({
              project_id: projectId,
              page_id: bl.targetPageId,
              source_url: bl.sourceUrl,
              source_domain: bl.sourceDomain,
              anchor_text: bl.anchorText,
              is_followed: bl.isFollowed,
              first_seen_at: now,
              last_seen_at: now,
            });
          }
        }
      }
    }

    if (discovered.length === 0) {
      console.log("Backlink check complete — no backlinks discovered");
      return 0;
    }

    // Clear old backlinks for this project and insert new ones
    const { error: deleteError } = await supabase
      .from("backlinks")
      .delete()
      .eq("project_id", projectId);

    if (deleteError) {
      console.error("Error clearing old backlinks:", deleteError);
    }

    // Insert in batches
    const insertBatchSize = 50;
    let totalInserted = 0;

    for (let i = 0; i < discovered.length; i += insertBatchSize) {
      const batch = discovered.slice(i, i + insertBatchSize);
      const { error: insertError } = await supabase
        .from("backlinks")
        .insert(batch);

      if (insertError) {
        console.error("Error inserting backlinks batch:", insertError);
      } else {
        totalInserted += batch.length;
      }
    }

    console.log(
      `Backlink check complete: ${totalInserted} backlinks discovered for project ${projectId}`,
    );
    return totalInserted;
  } catch (error) {
    console.error("Error in backlink checker:", error);
    return 0;
  }
}

interface FoundBacklink {
  sourceUrl: string;
  sourceDomain: string;
  targetPageId: string | null;
  anchorText: string | null;
  isFollowed: boolean;
}

/**
 * Fetch an external page and look for links back to the project domain.
 */
async function fetchAndFindBacklinks(
  externalUrl: string,
  projectDomain: string,
  pageUrlToId: Map<string, string>,
): Promise<FoundBacklink[]> {
  const backlinks: FoundBacklink[] = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

    const response = await fetch(externalUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RankRiotBot/1.0; +https://rankriot.com/bot)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) return backlinks;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return backlinks;

    const html = await response.text();

    // Extract the source domain
    let sourceDomain: string;
    try {
      sourceDomain = new URL(externalUrl).hostname.replace(/^www\./, "");
    } catch {
      return backlinks;
    }

    // Skip if the external page is actually on the same domain
    if (sourceDomain === projectDomain) return backlinks;

    // Find all <a> tags with href pointing to the project domain
    const linkRegex = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*?>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const anchorHtml = match[2];
      const fullTag = match[0];

      // Check if the href points to our project domain
      let targetUrl: string;
      try {
        // Handle relative URLs by resolving against the external page
        targetUrl = new URL(href, externalUrl).href;
      } catch {
        continue;
      }

      let targetDomain: string;
      try {
        targetDomain = new URL(targetUrl).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }

      if (targetDomain !== projectDomain) continue;

      // Found a backlink! Extract details
      const anchorText = anchorHtml.replace(/<[^>]*>/g, "").trim() || null;
      const isNoFollow = /rel\s*=\s*["'][^"']*nofollow[^"']*["']/i.test(fullTag);
      const targetPageId = pageUrlToId.get(targetUrl) ?? null;

      backlinks.push({
        sourceUrl: externalUrl,
        sourceDomain,
        targetPageId: targetPageId,
        anchorText,
        isFollowed: !isNoFollow,
      });
    }
  } catch {
    // Fetch failed (timeout, DNS, etc.) — silently skip
  }

  return backlinks;
}
