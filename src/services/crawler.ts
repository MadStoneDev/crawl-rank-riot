// Import necessary libraries and utilities
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { URL } from "url";

import { supabase } from "../db/supabase";
import logger from "../utils/logger";
import { updateScanProgress } from "./scanner";
import { LinkData, IssueData } from "../types";

const userAgent =
  "Mozilla/5.0 (compatible; RankRiotBot/1.0; +https://rankriot.app/bot)";

// Define a fetch with timeout function
async function fetchWithTimeout(
  url: string,
  options: any = {},
  timeout = 30000,
) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

/**
 * Start a web crawl for the given scan
 */
export async function startCrawl(scan: any): Promise<void> {
  logger.info(
    `Starting crawl for scan ${scan.id} of project ${scan.project_id}`,
  );

  const projectUrl = scan.projects.url;
  const parsedUrl = new URL(projectUrl);
  const hostname = parsedUrl.hostname;

  // Initialize counters
  let pagesScanned = 0;
  let linksScanned = 0;
  let issuesFound = 0;
  let lastProgressUpdate = Date.now();
  const PROGRESS_UPDATE_INTERVAL = 5000; // Update every 5 seconds

  // Set up crawl tracking
  const pagesToCrawl: string[] = [projectUrl];
  const crawledUrls = new Set<string>();
  const foundUrls = new Set<string>();
  foundUrls.add(projectUrl);

  // Continue crawling while there are pages in the queue
  while (pagesToCrawl.length > 0) {
    const currentUrl = pagesToCrawl.shift();

    if (!currentUrl || crawledUrls.has(currentUrl)) {
      continue;
    }

    try {
      logger.debug(`Crawling ${currentUrl}`);

      // Fetch the page with timeout
      const response = await fetchWithTimeout(currentUrl, {
        headers: {
          "User-Agent": userAgent,
        },
      });

      // Check if this is an HTML page
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        logger.debug(`Skipping non-HTML content: ${currentUrl}`);
        crawledUrls.add(currentUrl);
        continue;
      }

      // Get the page content
      const html = await response.text();

      // Parse with cheerio
      const $ = cheerio.load(html);

      // Extract page info
      const title = $("title").text().trim();
      const metaDescription =
        $('meta[name="description"]').attr("content") || "";
      const h1Text = $("h1").first().text().trim();

      // Store page in database
      const { data: page, error: pageError } = await supabase
        .from("pages")
        .upsert(
          {
            project_id: scan.project_id,
            url: currentUrl,
            title: title || null,
            meta_description: metaDescription || null,
            http_status: response.status,
            content_type: contentType || null,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "project_id, url",
          },
        )
        .select()
        .single();

      if (pageError) {
        logger.error(`Error storing page ${currentUrl}: ${pageError.message}`);
      }

      // Check for SEO issues
      const issues = checkSeoIssues(
        html,
        currentUrl,
        title,
        metaDescription,
        h1Text,
      );

      // Store issues in database
      if (issues.length > 0 && page) {
        // Process each issue individually
        for (const issue of issues) {
          const { error: issueError } = await supabase.from("issues").insert({
            scan_id: scan.id,
            project_id: scan.project_id,
            page_id: page.id,
            issue_type: issue.issue_type,
            description: issue.description,
            severity: issue.severity,
            is_fixed: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          if (issueError) {
            logger.error(
              `Error storing issue for ${currentUrl}: ${issueError.message}`,
            );
          }
        }

        issuesFound += issues.length;
      }

      // Extract links
      const links = extractLinks(html, currentUrl, hostname);
      linksScanned += links.length;

      // Process links
      for (const link of links) {
        try {
          // Store link in database
          const { error: linkError } = await supabase.from("page_links").upsert(
            {
              source_page_id: page?.id || "",
              destination_url: link.destination_url,
              anchor_text: link.anchor_text,
              link_type: link.link_type,
              is_followed: link.is_followed,
              is_broken: false, // We'll check this later
              project_id: scan.project_id,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "source_page_id, destination_url",
            },
          );

          if (linkError) {
            logger.error(
              `Error storing link ${link.destination_url}: ${linkError.message}`,
            );
          }
        } catch (error) {
          logger.error(
            `Error processing link ${link.destination_url}: ${error}`,
          );
        }

        // Add internal links to crawl queue if they're new
        if (
          link.link_type === "internal" &&
          !foundUrls.has(link.destination_url)
        ) {
          pagesToCrawl.push(link.destination_url);
          foundUrls.add(link.destination_url);
        }
      }

      // Mark as crawled
      crawledUrls.add(currentUrl);
      pagesScanned++;

      // Update progress periodically
      const now = Date.now();
      if (now - lastProgressUpdate > PROGRESS_UPDATE_INTERVAL) {
        await updateScanProgress(
          scan.id,
          pagesScanned,
          linksScanned,
          issuesFound,
        );
        lastProgressUpdate = now;
      }
    } catch (error) {
      logger.error(`Error crawling ${currentUrl}: ${error}`);
      crawledUrls.add(currentUrl); // Mark as crawled to avoid retrying
    }
  }

  // Final progress update
  await updateScanProgress(scan.id, pagesScanned, linksScanned, issuesFound);

  logger.info(
    `Completed crawl for scan ${scan.id}: ${pagesScanned} pages, ${linksScanned} links, ${issuesFound} issues`,
  );
}

/**
 * Extract links from a page
 */
function extractLinks(
  html: string,
  pageUrl: string,
  hostname: string,
): LinkData[] {
  const links: LinkData[] = [];
  const seenUrls = new Set<string>();
  const $ = cheerio.load(html);

  try {
    const baseUrl = $("base").attr("href") || pageUrl;

    $("a").each((_, element) => {
      try {
        const anchor = $(element);
        const href = anchor.attr("href");

        if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
          return;
        }

        // Normalize URL
        let fullUrl;
        try {
          fullUrl = new URL(href, baseUrl).href;
        } catch (e) {
          return; // Skip invalid URLs
        }

        // Remove fragments
        const url = fullUrl.split("#")[0];

        // Skip if we've seen this URL on this page already
        if (seenUrls.has(url)) {
          return;
        }
        seenUrls.add(url);

        // Get anchor text
        const anchorText = anchor.text().trim();

        // Check if internal
        const linkUrl = new URL(url);
        const isInternal = linkUrl.hostname === hostname;

        // Add to links
        links.push({
          destination_url: url,
          anchor_text: anchorText || null,
          link_type: isInternal ? "internal" : "external",
          is_followed: !anchor.attr("rel")?.includes("nofollow"),
        });
      } catch (error) {
        // Skip problematic links
      }
    });
  } catch (error) {
    logger.error(`Error extracting links from ${pageUrl}: ${error}`);
  }

  return links;
}

/**
 * Check for SEO issues on a page
 */
function checkSeoIssues(
  html: string,
  url: string,
  title: string,
  description: string,
  h1: string,
): IssueData[] {
  const issues: IssueData[] = [];
  const $ = cheerio.load(html);

  // Check title
  if (!title) {
    issues.push({
      issue_type: "missing_title",
      description: "Page is missing a title tag",
      severity: "high",
    });
  } else if (title.length < 10) {
    issues.push({
      issue_type: "short_title",
      description: "Title is too short (less than 10 characters)",
      severity: "medium",
    });
  } else if (title.length > 60) {
    issues.push({
      issue_type: "long_title",
      description: "Title is too long (more than 60 characters)",
      severity: "low",
    });
  }

  // Check meta description
  if (!description) {
    issues.push({
      issue_type: "missing_description",
      description: "Page is missing a meta description",
      severity: "medium",
    });
  } else if (description.length < 50) {
    issues.push({
      issue_type: "short_description",
      description: "Meta description is too short (less than 50 characters)",
      severity: "low",
    });
  } else if (description.length > 160) {
    issues.push({
      issue_type: "long_description",
      description: "Meta description is too long (more than 160 characters)",
      severity: "low",
    });
  }

  // Check H1
  if (!h1) {
    issues.push({
      issue_type: "missing_h1",
      description: "Page is missing an H1 heading",
      severity: "medium",
    });
  }

  // Check for multiple H1s
  if ($("h1").length > 1) {
    issues.push({
      issue_type: "multiple_h1",
      description: `Page has ${$("h1").length} H1 headings`,
      severity: "medium",
    });
  }

  // Check image alt text
  const imagesWithoutAlt = $("img:not([alt])").length;
  if (imagesWithoutAlt > 0) {
    issues.push({
      issue_type: "images_without_alt",
      description: `${imagesWithoutAlt} images missing alt text`,
      severity: "medium",
    });
  }

  return issues;
}
