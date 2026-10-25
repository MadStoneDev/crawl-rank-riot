/**
 * Soft-404 detection (S-01): a page that returns HTTP 200 but is really a
 * "page not found" page. Search engines treat these as a defect — the page
 * should return 404/410. Detection is deterministic (phrase matching on the
 * page-defining text: title + H1s), so it is testable and safe for the
 * crawler's "source of truth" role; no network probing.
 *
 * We deliberately match only strongly not-found-specific phrases in the title
 * or an H1 (never a bare "404", which appears in legitimate article titles like
 * "Understanding 404 Errors"), to avoid false positives on real content.
 */

const NOT_FOUND_PATTERNS: RegExp[] = [
  /page not found/i,
  /page (?:you (?:requested|were looking for|asked for)|cannot be found|could not be found|can'?t be found|does ?n'?t exist|does not exist|is unavailable|has moved)/i,
  /\b404\b[^.]*\bnot found\b/i,
  /\bnot found\b[^.]*\b404\b/i,
  /no longer (?:exists|available)/i,
  /(?:sorry[,!]?\s*)?(?:this |that |the )?page (?:you(?:'re| are)? looking for )?(?:can'?t|cannot|could not|couldn'?t) be found/i,
  /oops[!,. ].*(?:not found|doesn'?t exist|can'?t be found)/i,
];

/** True when any of the page-defining texts reads like a not-found page. */
export function looksLikeNotFound(texts: Array<string | undefined | null>): boolean {
  for (const t of texts) {
    if (!t) continue;
    const s = t.trim();
    if (!s) continue;
    if (NOT_FOUND_PATTERNS.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * A soft 404 is a 2xx response whose title/H1 reads as "not found". Callers pass
 * the page-defining texts; the status gate ensures real 404/410 pages (already
 * flagged by status) aren't double-counted.
 */
export function isSoft404(
  status: number,
  title: string | undefined,
  h1s: string[] | undefined,
): boolean {
  if (!(status >= 200 && status < 300)) return false;
  return looksLikeNotFound([title, ...(h1s ?? [])]);
}
