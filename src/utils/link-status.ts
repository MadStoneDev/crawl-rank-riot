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

// Why a link probe threw (status 0 otherwise hides the cause). Only
// dns_not_found and connection_refused mean the link is genuinely broken;
// timeout and TLS problems mean "couldn't verify" (P0 follow-up #2).
export type FetchErrorReason =
  | "dns_not_found"
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "network_error";

// Known OpenSSL/Node TLS-verification error codes that don't contain "CERT"
// (so the substring check alone would miss them).
const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EPROTO", // TLS handshake/protocol failure
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

/** Extract the most specific raw error code from a thrown fetch/undici error. */
export function extractErrorCode(err: unknown): string {
  const e = err as {
    name?: string;
    code?: string;
    cause?: { code?: string; name?: string };
  };
  return (e?.cause?.code || e?.code || e?.cause?.name || e?.name || "").toString();
}

export function classifyFetchError(err: unknown): FetchErrorReason {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  const code = extractErrorCode(err).toUpperCase();
  if (
    e?.name === "AbortError" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "ETIMEDOUT"
  ) {
    return "timeout";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_not_found";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.includes("CERT") ||
    TLS_CODES.has(code)
  ) {
    return "tls_error";
  }
  return "network_error";
}

/** True only for reasons that mean the link is genuinely dead. */
export function fetchErrorIsBroken(reason: FetchErrorReason): boolean {
  return reason === "dns_not_found" || reason === "connection_refused";
}
