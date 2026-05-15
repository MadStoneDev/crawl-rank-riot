# RankRiot Crawler Audit - 2026-05-16

## Overview

Exhaustive audit of the crawl-rank-riot codebase covering bugs, gaps, architecture issues, and competitive analysis against Screaming Frog, Ahrefs, Sitebulb, Lumar, SEMrush, and Moz.

**Codebase**: 16 TypeScript source files, ~5,571 lines
**Architecture**: Express 5 API + Puppeteer headless scanning + Supabase persistence

---

## PART 1: CONFIRMED BUGS (User-Reported)

### BUG-1: .txt/.md files treated as pages

**Severity**: Important
**Files**: `src/utils/url.ts:427-448`

The `shouldExclude` method only filters images, PDFs, docs, media files, and specific path patterns. It has zero filtering for:
- `.txt` files (llms.txt, llms-full.txt, robots.txt)
- `.md` files (agents.md)
- `.xml` files (when discovered as a link)
- `.json`, `.csv`, `.yaml`, `.yml` files

Any `<a href="/llms.txt">` on a page gets added to the crawl queue and crawled as a normal HTML page.

**Fix**: Add non-HTML file extension filtering to `shouldExclude`.

---

### BUG-2: Shopify sitemaps not found

**Severity**: Critical
**Files**: `src/services/crawler.ts:431`, `src/services/crawler.ts:476-477`

Two issues:
1. The sitemap fetcher at line 431 uses User-Agent `"RankRiot/1.0 SEO Crawler"`. Shopify's CDN returns 403 for bot-like user agents on `/sitemap.xml`. The headless scanner uses a realistic Chrome UA, but sitemap fetching doesn't.
2. Nested sitemap fetches (from robots.txt or sitemap indexes) at line 476 include NO headers at all -- no User-Agent whatsoever.

**Fix**: Use a realistic browser User-Agent for all sitemap/robots.txt fetches.

---

### BUG-3: Contact page excluded then reported as missing

**Severity**: Critical (self-defeating logic)
**Files**: `src/utils/url.ts:442`, `src/services/audit-analyzer.ts:206-291`

The `shouldExclude` method has this pattern:
```
/contact|about\/team/i
```

This excludes ALL URLs containing "contact" from being crawled. Then `audit-analyzer.ts:analyzeCompleteness` checks if contact pages exist in crawl results and reports them as missing. The crawler prevents itself from finding contact pages.

Additionally, the form-based contact detection at `audit-analyzer.ts:266-281` only searches for `type="email"` in serialized JSON. It does NOT look for `<textarea>`, `<form>` elements, or message fields.

**Fix**: Remove "contact" from the default exclusion list (it belongs in SEO crawl exclusions, not audit exclusions). Implement actual form detection for contact pages.

---

### BUG-4: Returns/shipping pages not found on Shopify

**Severity**: Important
**Files**: `src/services/audit-analyzer.ts:216-229`, `src/services/audit-analyzer.ts:340-351`

The `pageAliases` map only defines aliases for: blog, about, contact, services, team.

The expected ecommerce pages include `"returns"` and `"shipping"`, but there are no aliases for them. The check does `path.includes("returns")` which misses Shopify's standard paths:
- `/policies/refund-policy` (not "returns")
- `/policies/shipping-policy` (not "shipping")
- `/policies/privacy-policy`
- `/policies/terms-of-service`

**Fix**: Add comprehensive aliases for ecommerce pages.

---

### BUG-5: mailto: links treated as pages

**Severity**: Important
**Files**: `src/services/scanner.ts:502-558`

The headless `extractLinks` method at line 524 filters with `/^https?:\/\//i.test(link.href)`, which should catch `mailto:` links. However, the user is seeing this in production. Possible causes:
- Some themes use JS click handlers where `href` is a regular path but behavior triggers email
- Edge cases with malformed mailto links
- The HTTP-mode `extractLinksFromHtml` at lines 938-994 may have gaps in its regex-based extraction

**Fix**: Add explicit protocol filtering (`mailto:`, `tel:`, `javascript:`, `data:`, `ftp:`) at multiple levels.

---

## PART 2: CRITICAL ARCHITECTURAL ISSUES

### CRIT-1: Self-defeating URL exclusion patterns

**File**: `src/utils/url.ts:430-443`

The default exclusion patterns actively prevent crawling pages the audit analyzer needs:

| Pattern | Problem |
|---------|---------|
| `/contact\|about\/team/i` | Blocks all contact and about/team pages |
| `/privacy-policy\|terms\|cookie-policy/i` | Blocks legal pages needed for completeness checks |
| `/login\|logout\|register\|signin\|signup/i` | Could false-positive on `/design/login-page-template` |
| `/\?.*sort/i` | Matches URLs like `/resort` or `/sorting-guide` (substring match on full URL) |

These patterns use `test(url)` against the FULL URL (including domain), so `contact` in a domain name would trigger exclusion.

**Impact**: Audit projects fundamentally cannot check for the pages they're supposed to check for.

---

### CRIT-2: Browser resource leak in headless scanning

**File**: `src/services/scanner.ts:53-133`

A NEW Puppeteer browser instance is launched for EVERY page scanned in headless mode (line 59: `browser = await puppeteer.launch()`). With concurrent crawling, this spawns multiple Chrome processes simultaneously. For a 500-page Shopify scan, this means 500 Chrome process launches.

**Impact**: Memory exhaustion, server instability, dramatically slower scans.
**Fix**: Use a shared browser pool -- launch once, create pages as needed, share across concurrent scans.

---

### CRIT-3: Race condition in concurrent URL processing

**File**: `src/services/crawler.ts:307-325`

`getNextBatch` marks URLs as visited (line 321: `this.visited.add(item.url)`) before processing completes. If `processUrl` fails transiently (network timeout, 503, etc.), the URL is permanently marked as visited and will never be retried.

**Impact**: Transient failures cause pages to be silently skipped forever. On flaky sites, significant portions of the site could be missed.
**Fix**: Only mark as visited after successful processing, or implement a retry mechanism.

---

### CRIT-4: No project ownership check on scan endpoints

**File**: `src/routes/scan.ts:41-56`, `src/routes/scan.ts:172-187`

The scan endpoints validate that a project exists but never verify the authenticated user (`req.user`) owns the project. Any authenticated user can trigger scans on any project ID.

**Impact**: Security vulnerability -- users can consume other users' scan quotas or trigger unwanted scans.
**Fix**: Add `user_id` check to project ownership query.

---

### CRIT-5: Exposed credentials in .env file

**File**: `.env`

The `.env` file contains:
- Supabase anon key
- Supabase service role key
- MailerSend API token

While `.env` is in `.gitignore`, these are real production credentials. The service role key has full admin access to the database.

**Impact**: If the repo were made public or .env were accidentally committed, full database access would be exposed.

---

## PART 3: IMPORTANT ISSUES

### IMP-1: hasRobotsTxt always returns false

**File**: `src/services/audit-analyzer.ts:622`
Variable initialized to `false`, never updated. Audit always reports no robots.txt regardless of reality.

### IMP-2: hasSitemap always returns false

**File**: `src/services/audit-analyzer.ts:659-661`
Checks if any crawled URL contains "sitemap" in its URL. But sitemap.xml is fetched for discovery, not added to crawl results. Always false.

### IMP-3: Social platform string replacement bug

**File**: `src/services/audit-analyzer.ts:603-604`
`.replace("x", "X (Twitter)")` replaces the first `x` character in ANY string. Example: `"facebook"` becomes `"facebooX (Twitter)k"`.
**Fix**: Use `.replace(/^x$/, "X (Twitter)")`.

### IMP-4: Supabase service client recreated per call

**File**: `src/services/database/client.ts:42-61`
`getSupabaseServiceClient()` creates a NEW client every call, unlike `getSupabaseClient()` which uses a singleton. Called many times per scan (progress updates, storing results, etc.).

### IMP-5: Env var name mismatch

**File**: `src/services/database/client.ts:44` vs `src/config/index.ts:16`
Code reads `SUPABASE_SERVICE_KEY` but config/docs reference `SUPABASE_SERVICE_ROLE_KEY`. Different env var names.

### IMP-6: supportsHttps only works for 7 hardcoded domains

**File**: `src/utils/url.ts:538-553`
The method only recognizes github.com, google.com, etc. For all other domains (99.99% of the internet), http: URLs are never upgraded to https:.
**Fix**: Default to HTTPS for all domains (modern web is HTTPS-first).

### IMP-7: Sitemap URLs bypass shouldExclude

**File**: `src/services/crawler.ts:506-530`
URLs from sitemaps are checked with `isInternal()` but NOT with `shouldExclude()`. Image URLs, admin paths, etc. from sitemaps get added to the crawl queue, waste queue space, and count toward maxPages.

### IMP-8: Duplicated isJavaScriptHeavySite method

**Files**: `src/services/crawler.ts:396-409` AND `src/services/scanner.ts:37-51`
Identical method in two places. If one gets updated, they'll diverge.

### IMP-9: Sitemap depth capped at 3

**File**: `src/services/crawler.ts:539-543`
`calculateUrlDepth` caps depth at 3 regardless of configured `maxDepth`. Sitemap URLs with deeper paths get depth 3 and may be skipped if maxDepth < 3.

### IMP-10: Scheduled crawls missing scan_type

**File**: `src/utils/scheduler.ts:82-89`
Scheduled scans don't set `scan_type`, so they may not be properly displayed in the frontend.

### IMP-11: Deploy script wrong file extension

**File**: `.github/workflows/deploy.yml:33`
References `dist/app.ts` instead of `dist/app.js`. After `tsc` compilation, the output is `.js`.

### IMP-12: Double progress update on completion

**Files**: `src/services/crawler.ts:301` and `src/routes/scan.ts:367-375`
`finalProgressUpdate()` sets status to "completed", then `processSEOScanInBackground` also sets it to "completed" with potentially different `summary_stats`.

### IMP-13: Error handler logs req.body to console

**File**: `src/services/api/responses.ts:66`
Could leak sensitive data (tokens, credentials) to logs.

---

## PART 4: MINOR ISSUES

| # | File | Issue |
|---|------|-------|
| M-1 | `crawler.ts:19` | Comment says "2 seconds" but value is 1000ms (1 second) |
| M-2 | `package.json` | Express 5.1 with @types/express 4.x -- API breaking changes |
| M-3 | `crawler.ts:391-393` | `isInQueue()` method is dead code |
| M-4 | `package.json` | Unused dependency: cheerio (never imported) |
| M-5 | `package.json` | Unused dependency: axios (never imported) |
| M-6 | `package.json` | Unused dependency: uuid (never imported) |
| M-7 | `package.json` | Unused dependency: @upstash/redis (never imported) |
| M-8 | `audit-analyzer.ts:549` | Copyright year regex too greedy -- matches any 4 digits after "copyright" |
| M-9 | `scanner.ts:1108` | Keyword extraction only matches Latin chars (`[a-z]{4,}`) -- fails for CJK, Cyrillic, Arabic |
| M-10 | No test files exist | `npm test` exits with error, no test suite |

---

## PART 5: COMPETITIVE GAP ANALYSIS

### What RankRiot does BETTER than competitors

| Feature | RankRiot | Competitors |
|---------|----------|-------------|
| AEO/GEO Readiness scoring | Full checklist with AI bot detection, llms.txt, structured data for AI | Only SEMrush has comparable (since 2025) |
| AI bot blocking detection | Checks robots.txt for AI crawler blocks | Only SEMrush |
| Developer-friendly output | Shows actual data (images with alt text, titles, etc.) | Competitors bury data in tab-heavy UIs |
| llms.txt detection | Checks presence and validates | Only SEMrush |
| 40+ automated checklist items | Comprehensive across 8 categories | Comparable |

### What competitors ALL do that RankRiot doesn't

These are table-stakes features every major competitor has:

| Feature | Gap Severity | Notes |
|---------|-------------|-------|
| Core Web Vitals (LCP, CLS, INP) | HIGH | Every competitor integrates with PSI or Lighthouse |
| Structured data validation | HIGH | All validate against Schema.org + Google rich results |
| Image file size / dimensions / format | HIGH | RankRiot only stores `{src, alt}` -- no size, format, dimensions |
| Exact duplicate detection (body hash) | HIGH | RankRiot uses keyword Jaccard only |
| Hreflang validation | HIGH | RankRiot stores tags but never validates them |
| Internal PageRank / Link Score | HIGH | All competitors compute page-level authority |
| JavaScript rendering (headless) | MEDIUM | 4 of 6 competitors offer rendered HTML comparison |
| Readability scoring | MEDIUM | Flesch reading ease is standard |
| Anchor text analysis | MEDIUM | Flag "click here", "read more", distribution analysis |
| Redirect loop detection | MEDIUM | Currently only chain detection |
| Canonical chain validation | MEDIUM | Canonical -> canonical -> canonical |
| Mobile-friendliness (beyond viewport) | MEDIUM | Tap targets, font sizes, content sizing |
| Sitemap vs crawl comparison | MEDIUM | Pages in sitemap but not found, and vice versa |

### What no/few competitors do that RankRiot could own

| Feature | Opportunity |
|---------|-------------|
| Image resolution/size/format analysis with actionable feedback | "This 4000x3000 JPEG is displayed at 400x300 -- save 94% by resizing and converting to WebP" |
| Plain-English issue explanations for developers | Not just "missing alt text" but "screen readers can't describe this image, and Google can't index it for image search" |
| Contact form detection via DOM analysis | Scan for `<form>` with `<textarea>` -- smarter than path matching |
| E-commerce page detection via content analysis | Detect product pages, cart, etc. by content, not just URL path |
| Before/after scan comparison with visual diff | "These 3 issues were fixed since last scan, these 2 are new" |

---

## PART 6: PERFORMANCE & ARCHITECTURE RECOMMENDATIONS

### Crawler Speed

| Area | Current | Recommended |
|------|---------|-------------|
| Browser management | New Chrome per page | Shared browser pool (1-3 instances) |
| Concurrent requests | Configurable (default 3) | Good, but browser pool needed for headless |
| Sitemap parsing | Sequential fetch | Parallel fetch with backpressure |
| Result storage | Store all at end | Stream results as pages are crawled |
| Progress updates | Every 1 second | Good frequency |

### Accuracy

| Area | Current | Recommended |
|------|---------|-------------|
| URL filtering | Aggressive default exclusions | Separate exclusion profiles for SEO vs audit |
| Contact detection | Path-matching only | Form detection (look for textarea/email inputs in HTML) |
| E-commerce detection | Basic URL pattern matching | Content-based detection (product schema, add-to-cart buttons) |
| Duplicate detection | Keyword Jaccard | Content hash (MD5) + minhash for near-duplicates |
| Title extraction | Regex-based | Already good, but should handle `<title>` in `<body>` edge case |
| Link extraction | Regex (HTTP) + DOM (headless) | Always use DOM parsing (switch to cheerio for HTTP mode) |

### Reliability

| Area | Current | Recommended |
|------|---------|-------------|
| Failed URL handling | Marked visited, never retried | Retry queue with exponential backoff (3 attempts) |
| Scan timeout | 5 min hard timeout | Progressive timeout based on site size |
| Error reporting | Console.log | Structured error tracking per-scan |
| Graceful degradation | Binary success/fail | Partial results on timeout/error |

---

## PART 7: PRIORITY FIX ORDER

### Phase 1: Critical Bugs -- DONE (de46608)
1. [x] Fix self-defeating URL exclusions (separate SEO vs audit exclusion profiles)
2. [x] Fix sitemap User-Agent for Shopify
3. [x] Add non-HTML file extension filtering
4. [x] Add ecommerce page aliases (refund-policy, shipping-policy, etc.)
5. [x] Fix mailto:/tel: link filtering (already handled by upstream)
6. [x] Add project ownership check to scan endpoints (already in upstream)
7. [x] Fix hasRobotsTxt and hasSitemap always-false bugs
8. [x] Fix social platform string replacement bug

### Phase 2: Architecture -- DONE (420362c)
9. [x] Implement browser pool for headless scanning
10. [x] Fix race condition in URL processing (retry mechanism)
11. [x] Cache Supabase service client (already singleton in upstream)
12. [x] Fix env var name mismatch (SUPABASE_SERVICE_KEY / SERVICE_ROLE_KEY)
13. [x] Remove unused dependencies (cleaned in upstream)
14. [x] Fix deploy script extension (fixed in upstream)

### Phase 3: Feature Gaps -- DONE (16869af)
15. [x] Enhanced image analysis (file size via HEAD requests, flagging >200KB)
16. [x] Contact form detection via DOM analysis (form+textarea, email+keywords)
17. [x] Content hash for exact duplicate detection (SHA-256)
18. [x] Readability scoring (Flesch Reading Ease)
19. [x] Structured data validation (9d4407e — per-type required field checks)
20. [ ] Core Web Vitals integration / PageSpeed Insights API (future)

### Phase 4: Competitive Features -- DONE (9e6bbef, 9d4407e)
21. [x] Orphan page detection (9d4407e — pages with zero internal inbound links)
22. [x] Hreflang validation (self-ref, x-default, lang code format)
23. [x] Anchor text distribution analysis (generic anchor detection)
24. [x] Redirect loop detection
25. [x] Canonical chain validation (canonical-not-self detection)
26. [ ] Mobile-friendliness checks beyond viewport (future)
27. [x] Sitemap vs crawl comparison report (already in site-analyzer.ts)

### Additional fixes applied
- Site analyzer User-Agent changed from bot-like to browser UA (9d4407e)
