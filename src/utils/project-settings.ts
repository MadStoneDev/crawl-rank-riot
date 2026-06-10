import { CrawlOptions } from "../types";

// Reads the per-project advanced configuration stored in projects.settings
// (JSONB). The shape is written by the frontend — keep key names in sync with
// rank-riot/src/lib/project-settings.ts. Everything here is defensive: the
// column is untyped JSON and may contain anything.

export interface ProjectCrawlSettings {
  /** Overrides merged into CrawlOptions before a scan starts */
  crawlOverrides: Pick<
    CrawlOptions,
    "customSitemapPaths" | "seedPaths" | "wwwPreference" | "forceHeadless"
  > & { excludePatterns?: RegExp[] };
  /** Custom key page paths (contact, about, ...) for audit completeness checks */
  keyPages: Record<string, string>;
}

/**
 * Same host, or a subdomain of it, ignoring a leading "www.". Host-suffix
 * matching — safe for multi-label TLDs like .com.au without a suffix list.
 */
function isSameSite(targetHost: string, baseHost: string): boolean {
  const t = targetHost.toLowerCase();
  const b = baseHost.toLowerCase().replace(/^www\./, "");
  return t === b || t.endsWith(`.${b}`);
}

function asPath(
  value: unknown,
  allowFullUrl = false,
  baseHost: string | null = null,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300 || /\s/.test(trimmed)) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    if (!allowFullUrl) return null;
    try {
      const parsed = new URL(trimmed);
      // Cross-domain full URLs are rejected; without a known base host we
      // can't verify, so fail closed.
      if (!baseHost || !isSameSite(parsed.hostname, baseHost)) return null;
      return trimmed;
    } catch {
      return null;
    }
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseProjectSettings(
  settings: unknown,
  baseUrl?: string | null,
): ProjectCrawlSettings {
  const result: ProjectCrawlSettings = { crawlOverrides: {}, keyPages: {} };
  if (!settings || typeof settings !== "object") return result;

  let baseHost: string | null = null;
  if (baseUrl) {
    try {
      baseHost = new URL(
        baseUrl.includes("://") ? baseUrl : `https://${baseUrl}`,
      ).hostname;
    } catch {
      baseHost = null;
    }
  }

  const raw = settings as Record<string, any>;
  const crawl = raw.crawl && typeof raw.crawl === "object" ? raw.crawl : {};
  const pages = raw.pages && typeof raw.pages === "object" ? raw.pages : {};
  const customUrls = Array.isArray(raw.custom_urls) ? raw.custom_urls : [];

  const sitemapPaths: string[] = [];
  const mainSitemap = asPath(crawl.sitemap_path, true, baseHost);
  if (mainSitemap) sitemapPaths.push(mainSitemap);

  const seedPaths: string[] = [];
  for (const entry of customUrls.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "extra_sitemap") {
      const path = asPath(entry.url, true, baseHost);
      if (path) sitemapPaths.push(path);
    } else if (entry.type === "important_page") {
      const path = asPath(entry.url);
      if (path) seedPaths.push(path);
    }
  }

  for (const [key, value] of Object.entries(pages)) {
    const path = asPath(value);
    if (path) {
      result.keyPages[key] = path;
      // Key pages double as seeds so they're crawled even when unlinked
      seedPaths.push(path);
    }
  }

  if (sitemapPaths.length > 0) {
    result.crawlOverrides.customSitemapPaths = sitemapPaths;
  }
  if (seedPaths.length > 0) {
    result.crawlOverrides.seedPaths = [...new Set(seedPaths)];
  }

  if (crawl.www_preference === "www" || crawl.www_preference === "non-www") {
    result.crawlOverrides.wwwPreference = crawl.www_preference;
  }

  if (crawl.force_headless === true) {
    result.crawlOverrides.forceHeadless = true;
  }

  if (Array.isArray(crawl.exclude_patterns)) {
    const patterns = crawl.exclude_patterns
      .filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 0)
      .slice(0, 50)
      .map((p: string) => new RegExp(escapeRegExp(p.trim()), "i"));
    if (patterns.length > 0) {
      result.crawlOverrides.excludePatterns = patterns;
    }
  }

  return result;
}
