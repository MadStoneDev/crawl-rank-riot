import { SiteLevelData, ScanResult } from "../types";
import { isPublicUrl } from "../utils/url";
import { proxyFetch } from "../utils/proxy";
import { USER_AGENT } from "../config/identity";

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

    return {
      exists: true,
      content: content.slice(0, 5000),
      fields,
    };
  } catch {
    return { exists: false };
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

    const lines = content.split("\n").map((l) => l.trim());
    let currentUserAgent: string | null = null;
    const agentDirectives = new Map<
      string,
      { allow: string[]; disallow: string[] }
    >();

    for (const line of lines) {
      if (line.startsWith("#") || !line) continue;

      const lowerLine = line.toLowerCase();

      if (lowerLine.startsWith("sitemap:")) {
        const url = line.slice(8).trim();
        if (url) result.sitemap_urls.push(url);
        continue;
      }

      if (lowerLine.startsWith("user-agent:")) {
        currentUserAgent = line.slice(11).trim();
        if (!agentDirectives.has(currentUserAgent)) {
          agentDirectives.set(currentUserAgent, {
            allow: [],
            disallow: [],
          });
        }
        continue;
      }

      if (!currentUserAgent) continue;

      const directives = agentDirectives.get(currentUserAgent)!;

      if (lowerLine.startsWith("disallow:")) {
        const path = line.slice(9).trim();
        if (path) directives.disallow.push(path);
      } else if (lowerLine.startsWith("allow:")) {
        const path = line.slice(6).trim();
        if (path) directives.allow.push(path);
      }
    }

    for (const botName of AI_BOT_USER_AGENTS) {
      const botNameLower = botName.toLowerCase();
      let isBlocked = false;

      for (const [agent, directives] of agentDirectives) {
        if (agent.toLowerCase() === botNameLower || agent === "*") {
          const hasDisallowAll = directives.disallow.includes("/");
          const hasAllowAll = directives.allow.includes("/");

          if (agent.toLowerCase() === botNameLower) {
            if (hasDisallowAll && !hasAllowAll) {
              isBlocked = true;
            }
            break;
          }

          if (agent === "*" && hasDisallowAll && !hasAllowAll) {
            isBlocked = true;
          }
        }
      }

      if (isBlocked) {
        result.ai_bots_blocked.push(botName);
      } else {
        const hasExplicitEntry = Array.from(agentDirectives.keys()).some(
          (a) => a.toLowerCase() === botNameLower,
        );
        if (hasExplicitEntry) {
          result.ai_bots_allowed.push(botName);
        }
      }
    }

    for (const [agent, directives] of agentDirectives) {
      if (directives.disallow.length > 0) {
        result.blocked_paths.push({
          user_agent: agent,
          paths: directives.disallow,
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
      result.errors.push("Sitemap does not contain valid XML urlset or sitemapindex");
      return result;
    }

    let sitemapUrls: string[] = [];

    if (content.includes("<sitemapindex")) {
      const subSitemapUrls = extractLocsFromXml(content);

      for (const subUrl of subSitemapUrls.slice(0, 10)) {
        try {
          const subController = new AbortController();
          const subTimeout = setTimeout(() => subController.abort(), 10000);

          const subResponse = await proxyFetch(subUrl, {
            headers: { "User-Agent": USER_AGENT },
            signal: subController.signal,
            redirect: "follow",
          });

          clearTimeout(subTimeout);

          if (subResponse.ok) {
            const subContent = await subResponse.text();
            sitemapUrls.push(...extractLocsFromXml(subContent));
          } else {
            result.errors.push(
              `Sub-sitemap ${subUrl} returned HTTP ${subResponse.status}`,
            );
          }
        } catch {
          result.errors.push(`Failed to fetch sub-sitemap: ${subUrl}`);
        }
      }
    } else {
      sitemapUrls = extractLocsFromXml(content);
    }

    result.url_count = sitemapUrls.length;
    result.has_lastmod = content.includes("<lastmod>");
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
    let path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.hostname}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}
