import axios from "axios";
import cheerio from "cheerio";
import { v4 as uuidv4 } from "uuid";
import puppeteer from "puppeteer-core";

import config from "../config";
import CrawlQueue from "./queue";
import logger from "../utils/logger";
import { isAllowedByRobotsTxt, fetchAndParseRobotsTxt } from "./robots";

import { supabase } from "../db/supabase";
import { Json } from "../database.types";
import { Scan, PageData, LinkData, IssueData, QueueItem } from "../types";

// Create a singleton queue for all crawls
const crawlQueue = new CrawlQueue(config.crawler.concurrency);

// Start the crawl process
export async function startCrawl(scan: any): Promise<void> {
  try {
    const project = scan.projects;

    if (!project) {
      throw new Error("Project data not found in scan");
    }

    logger.info(`Starting crawl for ${project.url}`);

    // Clear any existing queue
    crawlQueue.clear();

    // Fetch and parse robots.txt
    await fetchAndParseRobotsTxt(project);

    // Get or refresh project with robots.txt data
    const { data: refreshedProject } = await supabase
      .from("projects")
      .select("*")
      .eq("id", project.id)
      .single();

    if (!refreshedProject) {
      throw new Error(`Could not refresh project data for ${project.id}`);
    }

    // Initialize counters
    let pagesScanned = 0;
    let linksScanned = 0;
    let issuesFound = 0;

    // Extract base URL for comparison
    const baseUrl = new URL(project.url);
    const baseHostname = baseUrl.hostname;

    // Maximum pages to scan (can be overridden in project settings)
    const maxPages = project.settings?.max_pages || config.crawler.maxPages;

    // Add the seed URL to the queue
    await crawlQueue.add(
      {
        url: project.url,
        depth: 0,
        priority: 100, // Highest priority for seed URL
      },
      async (item: QueueItem) => {
        // Check if we've reached the page limit
        if (pagesScanned >= maxPages) {
          crawlQueue.pause();
          return;
        }

        // Check robots.txt
        if (
          config.crawler.respectRobotsTxt &&
          !(await isAllowedByRobotsTxt(refreshedProject, item.url))
        ) {
          logger.info(`Skipping ${item.url} - disallowed by robots.txt`);
          return;
        }

        // Crawl the page
        const pageData = await crawlPage(item.url, item.depth, item.referrer);

        // Process the crawled page
        if (pageData) {
          // Save page to database
          const pageId = await savePage(pageData, project.id, scan.id);

          // Increment counters
          pagesScanned++;
          linksScanned += pageData.links.length;
          issuesFound += pageData.issues.length;

          // Update scan progress
          await updateScanProgress(
            scan.id,
            pagesScanned,
            linksScanned,
            issuesFound,
          );

          // Process links for further crawling
          for (const link of pageData.links) {
            try {
              // Only queue internal links
              if (link.link_type === "internal") {
                const linkUrl = new URL(link.destination_url);

                // Check if it's the same domain
                if (linkUrl.hostname === baseHostname) {
                  // Add to queue with diminishing priority by depth
                  await crawlQueue.add(
                    {
                      url: link.destination_url,
                      depth: item.depth + 1,
                      referrer: item.url,
                      priority: Math.max(0, 100 - (item.depth + 1) * 10), // Priority decreases with depth
                    },
                    async (item: QueueItem) => {
                      // This will recursively call the same function
                    },
                  );
                }
              }
            } catch (error) {
              logger.error(
                `Error processing link ${link.destination_url}: ${error}`,
              );
            }
          }
        }
      },
    );

    // Wait for the queue to complete
    while (crawlQueue.size > 0 || crawlQueue.pending > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    logger.info(
      `Crawl completed for ${project.url}. Pages: ${pagesScanned}, Links: ${linksScanned}, Issues: ${issuesFound}`,
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Crawl error: ${error.message}`);
    }
    throw new Error("Unknown crawl error");
  }
}

// Crawl a single page
async function crawlPage(
  url: string,
  depth: number,
  referrer?: string,
): Promise<PageData | null> {
  logger.info(`Crawling ${url} (depth: ${depth})`);

  const startTime = Date.now();
  let pageData: PageData | null = null;

  try {
    // First try with simple HTTP request (faster)
    pageData = await crawlWithHttp(url, depth);

    // If page is likely JavaScript-heavy, retry with puppeteer
    if (pageData && (pageData.js_count || 0) > 5) {
      pageData = await crawlWithPuppeteer(url, depth);
    }

    const endTime = Date.now();
    if (pageData) {
      pageData.load_time_ms = endTime - startTime;
    }

    return pageData;
  } catch (error) {
    logger.error(`Error crawling ${url}: ${error}`);

    // Return a minimal error page data
    return {
      url,
      title: null,
      h1s: null,
      h2s: null,
      h3s: null,
      meta_description: null,
      canonical_url: null,
      http_status:
        error instanceof axios.AxiosError
          ? error.response?.status || null
          : null,
      content_type: null,
      content_length: null,
      is_indexable: false,
      has_robots_noindex: false,
      has_robots_nofollow: false,
      redirect_url:
        error instanceof axios.AxiosError
          ? error.response?.headers?.location || null
          : null,
      load_time_ms: Date.now() - startTime,
      first_byte_time_ms: null,
      size_bytes: null,
      image_count: null,
      js_count: null,
      css_count: null,
      open_graph: null,
      twitter_card: null,
      structured_data: null,
      links: [],
      issues: [
        {
          issue_type: "error",
          description: `Failed to crawl: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          severity: "high",
        },
      ],
    };
  }
}

// Crawl a page using HTTP request
async function crawlWithHttp(
  url: string,
  depth: number,
): Promise<PageData | null> {
  // Track timing
  const startTime = Date.now();

  // Make the request
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "RankRiot Crawler/1.0 (+https://rankriot.app/bot)",
    },
    timeout: config.crawler.timeout,
    validateStatus: () => true, // Accept all status codes
    maxRedirects: 5,
  });

  const firstByteTime = Date.now() - startTime;

  // Handle non-HTML content
  const contentType = response.headers["content-type"] || "";
  if (!contentType.includes("text/html")) {
    return {
      url,
      title: null,
      h1s: null,
      h2s: null,
      h3s: null,
      meta_description: null,
      canonical_url: null,
      http_status: response.status,
      content_type: contentType,
      content_length:
        parseInt(response.headers["content-length"] || "0", 10) || null,
      is_indexable: false,
      has_robots_noindex: false,
      has_robots_nofollow: false,
      redirect_url:
        response.request?.res?.responseUrl !== url
          ? response.request?.res?.responseUrl
          : null,
      load_time_ms: null, // Set later
      first_byte_time_ms: firstByteTime,
      size_bytes: response.data?.length || null,
      image_count: 0,
      js_count: 0,
      css_count: 0,
      open_graph: null,
      twitter_card: null,
      structured_data: null,
      links: [],
      issues: [
        {
          issue_type: "non_html_content",
          description: `Page is not HTML (${contentType})`,
          severity: "medium",
        },
      ],
    };
  }

  // Parse with cheerio
  const $ = cheerio.load(response.data);

  // Extract page data
  const title = $("title").text().trim();
  const h1s = $("h1")
    .map((i, el) => $(el).text().trim())
    .get();
  const h2s = $("h2")
    .map((i, el) => $(el).text().trim())
    .get();
  const h3s = $("h3")
    .map((i, el) => $(el).text().trim())
    .get();
  const metaDescription = $('meta[name="description"]').attr("content") || null;
  const canonicalUrl = $('link[rel="canonical"]').attr("href") || null;

  const hasRobotsNoindex =
    $('meta[name="robots"]').attr("content")?.includes("noindex") || false;
  const hasRobotsNofollow =
    $('meta[name="robots"]').attr("content")?.includes("nofollow") || false;

  // Count resources
  const images = $("img").length;
  const scripts = $("script").length;
  const stylesheets = $('link[rel="stylesheet"]').length;

  // Extract links
  const links: LinkData[] = [];
  $("a[href]").each((i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    try {
      // Resolve relative URLs
      const resolvedUrl = new URL(href, url).href;
      const isInternal =
        new URL(resolvedUrl).hostname === new URL(url).hostname;

      links.push({
        destination_url: resolvedUrl,
        anchor_text: $(el).text().trim() || null,
        link_type: isInternal ? "internal" : "external",
        is_followed: !$(el).attr("rel")?.includes("nofollow"),
      });
    } catch (error) {
      // Skip invalid URLs
    }
  });

  // Continuing the crawlWithHttp function
  // Extract resources like images, scripts, and stylesheets
  $("link[href], script[src], img[src]").each((i, el) => {
    const src = $(el).attr("src") || $(el).attr("href");
    if (!src) return;

    try {
      // Resolve relative URLs
      const resolvedUrl = new URL(src, url).href;

      links.push({
        destination_url: resolvedUrl,
        anchor_text: null,
        link_type: "resource",
        is_followed: true,
      });
    } catch (error) {
      // Skip invalid URLs
    }
  });

  // Extract Open Graph data
  const openGraph: Record<string, string> = {};
  $('meta[property^="og:"]').each((i, el) => {
    const property = $(el).attr("property")?.replace("og:", "");
    const content = $(el).attr("content");
    if (property && content) {
      openGraph[property] = content;
    }
  });

  // Extract Twitter Card data
  const twitterCard: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((i, el) => {
    const name = $(el).attr("name")?.replace("twitter:", "");
    const content = $(el).attr("content");
    if (name && content) {
      twitterCard[name] = content;
    }
  });

  // Look for structured data
  const structuredData: any[] = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const json = JSON.parse($(el).html() || "{}");
      structuredData.push(json);
    } catch (error) {
      // Skip invalid JSON
    }
  });

  // Find issues
  const issues: IssueData[] = [];

  // Check for missing title
  if (!title) {
    issues.push({
      issue_type: "missing_title",
      description: "Page is missing a title tag",
      severity: "high",
    });
  } else if (title.length < 10 || title.length > 70) {
    issues.push({
      issue_type: "title_length",
      description: `Title length (${title.length} chars) is ${
        title.length < 10 ? "too short" : "too long"
      }`,
      severity: "medium",
    });
  }

  // Check for missing meta description
  if (!metaDescription) {
    issues.push({
      issue_type: "missing_meta_description",
      description: "Page is missing a meta description",
      severity: "medium",
    });
  } else if (metaDescription.length < 50 || metaDescription.length > 160) {
    issues.push({
      issue_type: "meta_description_length",
      description: `Meta description length (${
        metaDescription.length
      } chars) is ${metaDescription.length < 50 ? "too short" : "too long"}`,
      severity: "low",
    });
  }

  // Check for missing H1
  if (h1s.length === 0) {
    issues.push({
      issue_type: "missing_h1",
      description: "Page is missing an H1 tag",
      severity: "medium",
    });
  } else if (h1s.length > 1) {
    issues.push({
      issue_type: "multiple_h1",
      description: `Page has ${h1s.length} H1 tags, should have only one`,
      severity: "medium",
    });
  }

  // Check for broken link issues (will be updated later when links are checked)

  return {
    url,
    title: title || null,
    h1s: h1s.length > 0 ? h1s : null,
    h2s: h2s.length > 0 ? h2s : null,
    h3s: h3s.length > 0 ? h3s : null,
    meta_description: metaDescription,
    canonical_url: canonicalUrl,
    http_status: response.status,
    content_type: contentType,
    content_length: response.data.length,
    is_indexable: !hasRobotsNoindex,
    has_robots_noindex: hasRobotsNoindex,
    has_robots_nofollow: hasRobotsNofollow,
    redirect_url:
      response.request?.res?.responseUrl !== url
        ? response.request?.res?.responseUrl
        : null,
    load_time_ms: null, // Set later
    first_byte_time_ms: firstByteTime,
    size_bytes: response.data.length,
    image_count: images,
    js_count: scripts,
    css_count: stylesheets,
    open_graph: Object.keys(openGraph).length > 0 ? openGraph : null,
    twitter_card: Object.keys(twitterCard).length > 0 ? twitterCard : null,
    structured_data: structuredData.length > 0 ? structuredData : null,
    links,
    issues,
  };
}

// Crawl a page using Puppeteer (for JavaScript-heavy pages)
async function crawlWithPuppeteer(
  url: string,
  depth: number,
): Promise<PageData | null> {
  logger.info(`Using Puppeteer for JavaScript-heavy page: ${url}`);

  // Track timing
  const startTime = Date.now();

  // Launch browser
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || "/usr/bin/chromium-browser",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();

    // Set user agent
    await page.setUserAgent("RankRiot Crawler/1.0 (+https://rankriot.app/bot)");

    // Set viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Set timeout - ensure it has a default value
    page.setDefaultNavigationTimeout(config.crawler.timeout || 30000);

    // Track performance
    let firstByteTime = 0;
    page.on("response", (response) => {
      if (response.url() === url) {
        firstByteTime = Date.now() - startTime;
      }
    });

    // Navigate to page
    const response = await page.goto(url, { waitUntil: "networkidle2" });

    if (!response) {
      throw new Error("No response received");
    }

    // Wait a bit for any remaining JavaScript to execute
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Get content type
    const contentType = response.headers()["content-type"] || "";

    // Handle non-HTML content
    if (!contentType.includes("text/html")) {
      await browser.close();
      return {
        url,
        title: null,
        h1s: null,
        h2s: null,
        h3s: null,
        meta_description: null,
        canonical_url: null,
        http_status: response.status(),
        content_type: contentType,
        content_length:
          parseInt(response.headers()["content-length"] || "0", 10) || null,
        is_indexable: false,
        has_robots_noindex: false,
        has_robots_nofollow: false,
        redirect_url: response.url() !== url ? response.url() : null,
        load_time_ms: null, // Set later
        first_byte_time_ms: firstByteTime,
        size_bytes: null,
        image_count: 0,
        js_count: 0,
        css_count: 0,
        open_graph: null,
        twitter_card: null,
        structured_data: null,
        links: [],
        issues: [
          {
            issue_type: "non_html_content",
            description: `Page is not HTML (${contentType})`,
            severity: "medium",
          },
        ],
      };
    }

    // Extract page data using page.evaluate
    const pageData = await page.evaluate(() => {
      // Helper to get all text content from elements
      const getTextContent = (selector: string) => {
        return Array.from(document.querySelectorAll(selector))
          .map((el) => el.textContent?.trim() || "")
          .filter((text) => text.length > 0);
      };

      // Extract basic page data
      const title = document.title;
      const h1s = getTextContent("h1");
      const h2s = getTextContent("h2");
      const h3s = getTextContent("h3");

      // Extract meta description
      const metaDescription =
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute("content") || null;

      // Extract canonical URL
      const canonicalUrl =
        document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
        null;

      // Check for robots meta tags
      const robotsMeta =
        document
          .querySelector('meta[name="robots"]')
          ?.getAttribute("content") || "";
      const hasRobotsNoindex = robotsMeta.includes("noindex");
      const hasRobotsNofollow = robotsMeta.includes("nofollow");

      // Count resources
      const images = document.querySelectorAll("img").length;
      const scripts = document.querySelectorAll("script").length;
      const stylesheets = document.querySelectorAll(
        'link[rel="stylesheet"]',
      ).length;

      // Extract all links
      const links = Array.from(document.querySelectorAll("a[href]")).map(
        (el) => {
          const anchor = el as HTMLAnchorElement;
          return {
            href: anchor.href,
            text: anchor.textContent?.trim() || null,
            rel: anchor.getAttribute("rel") || null,
          };
        },
      );

      // Extract resource links
      const resourceLinks = Array.from(
        document.querySelectorAll("link[href], script[src], img[src]"),
      )
        .map((el) => {
          if (el instanceof HTMLLinkElement) {
            return { href: el.href, type: "link" };
          } else if (el instanceof HTMLScriptElement) {
            return { href: el.src, type: "script" };
          } else if (el instanceof HTMLImageElement) {
            return { href: el.src, type: "img" };
          }
          return null;
        })
        .filter(Boolean);

      // Extract Open Graph data
      const openGraph: Record<string, string> = {};
      document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
        const property = el.getAttribute("property")?.replace("og:", "");
        const content = el.getAttribute("content");
        if (property && content) {
          openGraph[property] = content;
        }
      });

      // Extract Twitter Card data
      const twitterCard: Record<string, string> = {};
      document.querySelectorAll('meta[name^="twitter:"]').forEach((el) => {
        const name = el.getAttribute("name")?.replace("twitter:", "");
        const content = el.getAttribute("content");
        if (name && content) {
          twitterCard[name] = content;
        }
      });

      // Look for structured data
      const structuredData: any[] = [];
      document
        .querySelectorAll('script[type="application/ld+json"]')
        .forEach((el) => {
          try {
            const json = JSON.parse(el.textContent || "{}");
            structuredData.push(json);
          } catch (error) {
            // Skip invalid JSON
          }
        });

      return {
        title,
        h1s,
        h2s,
        h3s,
        metaDescription,
        canonicalUrl,
        hasRobotsNoindex,
        hasRobotsNofollow,
        images,
        scripts,
        stylesheets,
        links,
        resourceLinks,
        openGraph,
        twitterCard,
        structuredData,
      };
    });

    // Process links from the page
    const processedLinks: LinkData[] = [];

    // Process regular links
    for (const link of pageData.links || []) {
      try {
        const isInternal =
          new URL(link.href).hostname === new URL(url).hostname;

        processedLinks.push({
          destination_url: link.href,
          anchor_text: link.text,
          link_type: isInternal ? "internal" : "external",
          is_followed: !link.rel?.includes("nofollow"),
        });
      } catch (error) {
        // Skip invalid URLs
      }
    }

    // Process resource links
    // Process resource links
    for (const resource of pageData.resourceLinks || []) {
      try {
        if (resource && resource.href) {
          // Add null check
          processedLinks.push({
            destination_url: resource.href,
            anchor_text: null,
            link_type: "resource",
            is_followed: true,
          });
        }
      } catch (error) {
        // Skip invalid URLs
      }
    }

    // Find issues
    const issues: IssueData[] = [];

    // Check for missing title
    if (!pageData.title) {
      issues.push({
        issue_type: "missing_title",
        description: "Page is missing a title tag",
        severity: "high",
      });
    } else if (pageData.title.length < 10 || pageData.title.length > 70) {
      issues.push({
        issue_type: "title_length",
        description: `Title length (${pageData.title.length} chars) is ${
          pageData.title.length < 10 ? "too short" : "too long"
        }`,
        severity: "medium",
      });
    }

    // Check for missing meta description
    if (!pageData.metaDescription) {
      issues.push({
        issue_type: "missing_meta_description",
        description: "Page is missing a meta description",
        severity: "medium",
      });
    } else if (
      pageData.metaDescription.length < 50 ||
      pageData.metaDescription.length > 160
    ) {
      issues.push({
        issue_type: "meta_description_length",
        description: `Meta description length (${
          pageData.metaDescription.length
        } chars) is ${
          pageData.metaDescription.length < 50 ? "too short" : "too long"
        }`,
        severity: "low",
      });
    }

    // Check for missing H1
    if (pageData.h1s.length === 0) {
      issues.push({
        issue_type: "missing_h1",
        description: "Page is missing an H1 tag",
        severity: "medium",
      });
    } else if (pageData.h1s.length > 1) {
      issues.push({
        issue_type: "multiple_h1",
        description: `Page has ${pageData.h1s.length} H1 tags, should have only one`,
        severity: "medium",
      });
    }

    // Close browser
    await browser.close();

    return {
      url,
      title: pageData.title || null,
      h1s: pageData.h1s.length > 0 ? pageData.h1s : null,
      h2s: pageData.h2s.length > 0 ? pageData.h2s : null,
      h3s: pageData.h3s.length > 0 ? pageData.h3s : null,
      meta_description: pageData.metaDescription,
      canonical_url: pageData.canonicalUrl,
      http_status: response.status(),
      content_type: contentType,
      content_length: null, // Hard to determine accurately with Puppeteer
      is_indexable: !pageData.hasRobotsNoindex,
      has_robots_noindex: pageData.hasRobotsNoindex,
      has_robots_nofollow: pageData.hasRobotsNofollow,
      redirect_url: response.url() !== url ? response.url() : null,
      load_time_ms: null, // Set later
      first_byte_time_ms: firstByteTime,
      size_bytes: null, // Hard to determine accurately with Puppeteer
      image_count: pageData.images,
      js_count: pageData.scripts,
      css_count: pageData.stylesheets,
      open_graph:
        Object.keys(pageData.openGraph).length > 0 ? pageData.openGraph : null,
      twitter_card:
        Object.keys(pageData.twitterCard).length > 0
          ? pageData.twitterCard
          : null,
      structured_data:
        pageData.structuredData.length > 0 ? pageData.structuredData : null,
      links: processedLinks,
      issues,
    };
  } catch (error) {
    // Close browser on error
    await browser.close();
    throw error;
  }
}

// Save page data to database
async function savePage(
  pageData: PageData,
  projectId: string,
  scanId: string,
): Promise<string> {
  const pageId = uuidv4();

  try {
    // Check if the page already exists
    const { data: existingPage } = await supabase
      .from("pages")
      .select("id")
      .eq("project_id", projectId)
      .eq("url", pageData.url)
      .single();

    // Prepare the page data
    const page = {
      id: existingPage?.id || pageId,
      project_id: projectId,
      url: pageData.url,
      title: pageData.title,
      h1s: pageData.h1s,
      h2s: pageData.h2s,
      h3s: pageData.h3s,
      meta_description: pageData.meta_description,
      canonical_url: pageData.canonical_url,
      http_status: pageData.http_status,
      content_type: pageData.content_type,
      content_length: pageData.content_length,
      is_indexable: pageData.is_indexable,
      has_robots_noindex: pageData.has_robots_noindex,
      has_robots_nofollow: pageData.has_robots_nofollow,
      redirect_url: pageData.redirect_url,
      load_time_ms: pageData.load_time_ms,
      first_byte_time_ms: pageData.first_byte_time_ms,
      size_bytes: pageData.size_bytes,
      image_count: pageData.image_count,
      js_count: pageData.js_count,
      css_count: pageData.css_count,
      open_graph: pageData.open_graph,
      twitter_card: pageData.twitter_card,
      structured_data: pageData.structured_data,
    };

    if (existingPage) {
      // Update existing page
      await supabase.from("pages").update(page).eq("id", existingPage.id);
    } else {
      // Insert new page
      await supabase.from("pages").insert(page);
    }

    // Save the scan snapshot
    await saveScanSnapshot(existingPage?.id || pageId, scanId, pageData);

    // Save links
    await saveLinks(existingPage?.id || pageId, projectId, pageData.links);

    // Save issues
    await saveIssues(
      existingPage?.id || pageId,
      projectId,
      scanId,
      pageData.issues,
    );

    return existingPage?.id || pageId;
  } catch (error) {
    logger.error(`Error saving page ${pageData.url}: ${error}`);
    throw error;
  }
}

// Save scan snapshot
async function saveScanSnapshot(
  pageId: string,
  scanId: string,
  pageData: PageData,
): Promise<void> {
  try {
    const snapshot = {
      id: uuidv4(),
      scan_id: scanId,
      page_id: pageId,
      url: pageData.url,
      title: pageData.title,
      h1s: pageData.h1s,
      h2s: pageData.h2s,
      h3s: pageData.h3s,
      meta_description: pageData.meta_description,
      http_status: pageData.http_status,
      is_indexable: pageData.is_indexable,
      content_length: pageData.content_length,
      snapshot_data: {
        canonical_url: pageData.canonical_url,
        has_robots_noindex: pageData.has_robots_noindex,
        has_robots_nofollow: pageData.has_robots_nofollow,
        redirect_url: pageData.redirect_url,
        load_time_ms: pageData.load_time_ms,
        first_byte_time_ms: pageData.first_byte_time_ms,
        size_bytes: pageData.size_bytes,
        image_count: pageData.image_count,
        js_count: pageData.js_count,
        css_count: pageData.css_count,
        open_graph: pageData.open_graph,
        twitter_card: pageData.twitter_card,
        structured_data: pageData.structured_data,
      },
      // Convert the issues array to JSON
      issues: pageData.issues as unknown as Json,
    };

    await supabase.from("scan_page_snapshots").insert(snapshot);
  } catch (error) {
    logger.error(`Error saving scan snapshot for page ${pageId}: ${error}`);
  }
}

// Save links
async function saveLinks(
  pageId: string,
  projectId: string,
  links: LinkData[],
): Promise<void> {
  try {
    // Filter out any empty or invalid links
    const validLinks = links.filter((link) => link.destination_url);

    if (validLinks.length === 0) {
      return;
    }

    // Insert all links
    const linkRecords = validLinks.map((link) => ({
      id: uuidv4(),
      project_id: projectId,
      source_page_id: pageId,
      destination_url: link.destination_url,
      anchor_text: link.anchor_text,
      link_type: link.link_type,
      is_followed: link.is_followed,
      // These will be updated later in a separate process
      is_broken: null,
      http_status: null,
      destination_page_id: null,
    }));

    await supabase.from("page_links").upsert(linkRecords, {
      onConflict: "source_page_id,destination_url",
      ignoreDuplicates: false,
    });
  } catch (error) {
    logger.error(`Error saving links for page ${pageId}: ${error}`);
  }
}

// Save issues
async function saveIssues(
  pageId: string,
  projectId: string,
  scanId: string,
  issues: IssueData[],
): Promise<void> {
  try {
    if (issues.length === 0) {
      return;
    }

    const issueRecords = issues.map((issue) => ({
      id: uuidv4(),
      project_id: projectId,
      scan_id: scanId,
      page_id: pageId,
      issue_type: issue.issue_type,
      description: issue.description,
      severity: issue.severity,
      is_fixed: false,
      details: issue.details || null,
    }));

    await supabase.from("issues").insert(issueRecords);
  } catch (error) {
    logger.error(`Error saving issues for page ${pageId}: ${error}`);
  }
}

// Update scan progress
async function updateScanProgress(
  scanId: string,
  pagesScanned: number,
  linksScanned: number,
  issuesFound: number,
): Promise<void> {
  try {
    await supabase
      .from("scans")
      .update({
        pages_scanned: pagesScanned,
        links_scanned: linksScanned,
        issues_found: issuesFound,
        updated_at: new Date().toISOString(),
      })
      .eq("id", scanId);
  } catch (error) {
    logger.error(`Error updating scan progress for ${scanId}: ${error}`);
  }
}
