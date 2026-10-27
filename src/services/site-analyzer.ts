import { SiteLevelData, ScanResult } from "../types";
import { proxyFetch } from "../utils/proxy";
import { USER_AGENT } from "../config/identity";
import { parseRobots, isPathAllowed, type RobotsTxt } from "../utils/robots";

const AI_BOT_USER_AGENTS = [
  "GPTBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "PerplexityBot",
  "Google-Extended",
  "Amazonbot",
  "Bytespider",
  "CCBot",
  "cohere-ai",
  "Diffbot",
  "FacebookBot",
  "ImagesiftBot",
  "Omgilibot",
  "YouBot",
];

export async function analyzeSiteLevelData(
  baseUrl: string,
  crawledResults: ScanResult[],
  options?: { sitemapPath?: string },
): Promise<SiteLevelData> {
  const origin = new URL(baseUrl).origin;

  const [llmsTxt, robotsTxt, sitemapValidation] = await Promise.allSettled([
    fetchLlmsTxt(origin),
    fetchAndParseRobotsTxt(origin),
    validateSitemap(origin, crawledResults, options?.sitemapPath),
  ]);

  return {
    llms_txt:
      llmsTxt.status === "fulfilled" ? llmsTxt.value : { exists: false },
    robots_txt:
      robotsTxt.status === "fulfilled"
        ? robotsTxt.value
        : {
            exists: false,
            ai_bots_blocked: [],
            ai_bots_allowed: [],
            blocked_paths: [],
            sitemap_urls: [],
          },
    sitemap_validation:
      sitemapValidation.status === "fulfilled"
        ? sitemapValidation.value
        : {
            found: false,
            valid: false,
            errors: ["Failed to validate sitemap"],
            has_lastmod: false,
            urls_in_sitemap_not_crawled: [],
            crawled_not_in_sitemap: [],
          },
  };
}

async function fetchLlmsTxt(
  origin: string,
): Promise<SiteLevelData["llms_txt"]> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await proxyFetch(`${origin}/llms.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { exists: false };
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("text/plain") &&
      !contentType.includes("text/")
    ) {
      return { exists: false };
    }

    const content = await response.text();
    if (!content.trim() || content.length > 100000) {
      return { exists: false };
    }

    const fields: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        if (key && value) {
          fields[key] = value;
        }
      }
    }

    // A useful llms.txt links out to the site's key pages (markdown links).
    // Count them so we can flag a present-but-empty file that references nothing.
    const linkCount = (content.match(/\[[^\]]+\]\([^)]+\)/g) || []).length;

    return {
      exists: true,
      content: content.slice(0, 5000),
      fields,
      link_count: linkCount,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Classify each known AI bot as blocked / explicitly-allowed under these
 * robots rules (RB-03). A bot is "blocked" when it cannot fetch the site root
 * (the matcher applies the bot's own group over `*`, with Allow overrides and
 * wildcards). A bot is listed as "allowed" only when robots.txt addresses it by
 * name (its own group) and does not block it — an absent bot is neither.
 */
export function classifyAiBots(
  robots: RobotsTxt,
  origin: string,
  result: { ai_bots_blocked: string[]; ai_bots_allowed: string[] },
): void {
  const root = `${origin}/`;
  for (const botName of AI_BOT_USER_AGENTS) {
    const token = botName.toLowerCase();
    const allowed = isPathAllowed(robots, root, [botName]);
    const hasOwnGroup = robots.groups.some((g) =>
      g.agents.some((a) => a !== "*" && token.startsWith(a)),
    );
    if (!allowed) {
      result.ai_bots_blocked.push(botName);
    } else if (hasOwnGroup) {
      result.ai_bots_allowed.push(botName);
    }
  }
}

async function fetchAndParseRobotsTxt(
  origin: string,
): Promise<NonNullable<SiteLevelData["robots_txt"]>> {
  const result: NonNullable<SiteLevelData["robots_txt"]> = {
    exists: false,
    ai_bots_blocked: [],
    ai_bots_allowed: [],
    blocked_paths: [],
    sitemap_urls: [],
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await proxyFetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return result;
    }

    const content = await response.text();
    if (!content.trim()) {
      return result;
    }

    result.exists = true;
    result.content = content.slice(0, 10000);

    // Parse + evaluate with the shared robots matcher (RB-03) so the AI-bot
    // verdict uses real group selection (a specific bot group overrides `*`),
    // Allow/Disallow longest-match and `*`/`$` wildcards — not a naive
    // "Disallow: / present" substring test that mis-reported bots as blocked
    // when their own group allowed them.
    const robots = parseRobots(content);
    result.sitemap_urls.push(...robots.sitemaps);

    classifyAiBots(robots, origin, result);

    for (const group of robots.groups) {
      const disallowPaths = group.rules
        .filter((r) => r.type === "disallow")
        .map((r) => r.path);
      if (disallowPaths.length > 0) {
        result.blocked_paths.push({
          user_agent: group.agents.join(", "),
          paths: disallowPaths,
        });
      }
    }
  } catch {
    // Non-critical
  }

  return result;
}

async function validateSitemap(
  origin: string,
  crawledResults: ScanResult[],
  customSitemapPath?: string,
): Promise<NonNullable<SiteLevelData["sitemap_validation"]>> {
  const result: NonNullable<SiteLevelData["sitemap_validation"]> = {
    found: false,
    valid: false,
    errors: [],
    has_lastmod: false,
    urls_in_sitemap_not_crawled: [],
    crawled_not_in_sitemap: [],
  };

  try {
    // Honour the project's custom sitemap path (relative or absolute);
    // fall back to the conventional /sitemap.xml
    let sitemapUrl = `${origin}/sitemap.xml`;
    if (customSitemapPath) {
      try {
        sitemapUrl = new URL(customSitemapPath, `${origin}/`).toString();
      } catch {
        // keep the default on a malformed custom path
      }
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await proxyFetch(sitemapUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      result.errors.push(`Sitemap returned HTTP ${response.status}`);
      return result;
    }

    const content = await response.text();
    result.found = true;
    result.url = sitemapUrl;

    if (!content.includes("<urlset") && !content.includes("<sitemapindex")) {
      // Capture WHAT was actually fetched so the user can tell whether the site
      // or the crawler is at fault. A valid Yoast XSL-styled sitemap still has a
      // <urlset> root, so landing here usually means gzip/HTML/redirect/WAF
      // content, not a real sitemap.
      const contentType = response.headers.get("content-type") || "unknown";
      const snippet = content.slice(0, 200).replace(/\s+/g, " ").trim();
      result.errors.push(
        `Sitemap did not contain a valid <urlset> or <sitemapindex> ` +
          `(HTTP ${response.status}, content-type: ${contentType}). ` +
          `First bytes: ${snippet || "(empty)"}`,
      );
      return result;
    }

    let sitemapUrls: string[] = [];
    let hasLastmod = content.includes("<lastmod>");

    if (content.includes("<sitemapindex")) {
      // A sitemap index points to more sitemaps (posts, products, pages, ...),
      // which may themselves be indexes. Traverse breadth-first, following
      // nesting up to a depth and an overall fetch cap, deduping and guarding
      // against loops.
      const MAX_SUB_SITEMAPS = 50;
      const MAX_DEPTH = 3;
      const visited = new Set<string>([normalizeForComparison(sitemapUrl)]);
      const queue = extractLocsFromXml(content).map((u) => ({ url: u, depth: 1 }));
      let scanned = 0;
      let capped = false;

      while (queue.length > 0) {
        if (scanned >= MAX_SUB_SITEMAPS) {
          capped = true;
          break;
        }
        const { url: subUrl, depth } = queue.shift()!;
        const norm = normalizeForComparison(subUrl);
        if (visited.has(norm)) continue;
        visited.add(norm);

        try {
          const subController = new AbortController();
          const subTimeout = setTimeout(() => subController.abort(), 10000);
          const subResponse = await proxyFetch(subUrl, {
            headers: { "User-Agent": USER_AGENT },
            signal: subController.signal,
            redirect: "follow",
          });
          clearTimeout(subTimeout);
          scanned++;

          if (!subResponse.ok) {
            result.errors.push(
              `Sub-sitemap ${subUrl} returned HTTP ${subResponse.status}`,
            );
            continue;
          }

          const subContent = await subResponse.text();
          if (subContent.includes("<lastmod>")) hasLastmod = true;

          if (subContent.includes("<sitemapindex")) {
            // Nested index — follow its children unless we're at the depth limit.
            if (depth < MAX_DEPTH) {
              for (const childUrl of extractLocsFromXml(subContent)) {
                queue.push({ url: childUrl, depth: depth + 1 });
              }
            } else {
              result.errors.push(
                `Sitemap nesting exceeds ${MAX_DEPTH} levels; ${subUrl} not fully traversed`,
              );
            }
          } else {
            sitemapUrls.push(...extractLocsFromXml(subContent));
          }
        } catch {
          result.errors.push(`Failed to fetch sub-sitemap: ${subUrl}`);
        }
      }

      result.sub_sitemaps_scanned = scanned;
      if (capped) {
        result.errors.push(
          `Sitemap index lists more than ${MAX_SUB_SITEMAPS} sub-sitemaps; only the first ${MAX_SUB_SITEMAPS} were scanned`,
        );
      }
      // The same page URL can appear across multiple sub-sitemaps.
      sitemapUrls = [...new Set(sitemapUrls)];
    } else {
      sitemapUrls = extractLocsFromXml(content);
    }

    result.url_count = sitemapUrls.length;
    result.has_lastmod = hasLastmod;
    result.valid = sitemapUrls.length > 0 && result.errors.length === 0;

    if (sitemapUrls.length === 0) {
      result.errors.push("Sitemap contains no URLs");
    }

    if (!result.has_lastmod) {
      result.errors.push("Sitemap is missing <lastmod> dates");
    }

    const crawledUrlSet = new Set(
      crawledResults
        .filter((r) => r.status >= 200 && r.status < 400)
        .map((r) => normalizeForComparison(r.url)),
    );

    const sitemapUrlSet = new Set(
      sitemapUrls.map((u) => normalizeForComparison(u)),
    );

    for (const sitemapNorm of sitemapUrlSet) {
      if (!crawledUrlSet.has(sitemapNorm)) {
        const original = sitemapUrls.find(
          (u) => normalizeForComparison(u) === sitemapNorm,
        );
        if (original) {
          result.urls_in_sitemap_not_crawled.push(original);
        }
      }
    }

    for (const crawledNorm of crawledUrlSet) {
      if (!sitemapUrlSet.has(crawledNorm)) {
        const original = crawledResults.find(
          (r) => normalizeForComparison(r.url) === crawledNorm,
        );
        if (original) {
          result.crawled_not_in_sitemap.push(original.url);
        }
      }
    }

    result.urls_in_sitemap_not_crawled =
      result.urls_in_sitemap_not_crawled.slice(0, 50);
    result.crawled_not_in_sitemap = result.crawled_not_in_sitemap.slice(0, 50);
  } catch {
    result.errors.push("Failed to fetch or parse sitemap");
  }

  return result;
}

function extractLocsFromXml(xml: string): string[] {
  const urls: string[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1].trim();
    if (url && /^https?:\/\//i.test(url)) {
      urls.push(url);
    }
  }
  return urls;
}

function normalizeForComparison(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.hostname}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}
