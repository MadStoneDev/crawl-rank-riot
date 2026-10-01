export type LinkStatusClass = "ok" | "redirect" | "broken" | "blocked";

// Status codes that mean the target refused an automated client — a bot wall,
// rate limit, auth gate, or temporary unavailability — NOT a dead page. These
// must never be reported as broken links (P0.4): Reddit/ActiveCampaign return
// 403, LinkedIn returns 999, and 429/503 are rate-limit / maintenance.
const BLOCKED_CODES = new Set([401, 403, 429, 503, 999]);

/**
 * Classify an HTTP status for link-health reporting.
 * - null/undefined/0  → broken (DNS failure, connection refused, timeout)
 * - 2xx               → ok
 * - 3xx               → redirect
 * - 401/403/429/503/999 → blocked (couldn't verify; site blocks crawlers)
 * - everything else ≥400 (404, 410, other 4xx, 5xx) → broken
 */
export function classifyLinkStatus(
  status: number | null | undefined,
): LinkStatusClass {
  if (status === null || status === undefined || status === 0) return "broken";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirect";
  if (BLOCKED_CODES.has(status)) return "blocked";
  return "broken";
}

/** True when a status means "the site blocked us", not "the page is dead". */
export function isBlockedStatus(status: number | null | undefined): boolean {
  return status != null && BLOCKED_CODES.has(status);
}

/** Codes worth one retry with a browser-like User-Agent before classifying. */
export function shouldRetryWithBrowserUa(
  status: number | null | undefined,
): boolean {
  return status === 403 || status === 429 || status === 999;
}
