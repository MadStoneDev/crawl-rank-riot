import { load, type CheerioAPI } from "cheerio";
import { ScanResult } from "../../types";
import { UrlProcessor } from "../../utils/url";
import { computeContentHash, computeReadabilityScore, countWords, extractKeywords } from "./text-metrics";

/**
 * The ONE DOM-string extractor (P-06). Given raw HTML (the server response on
 * the HTTP path, or `page.content()` on the headless path) and the page's final
 * URL, produce the DOM-derivable fields of a ScanResult. Pure: no network, no
 * I/O — so it is fully unit-testable with known-answer fixtures.
 *
 * Replaces the regex-based HTTP parsing in Scanner.processHtml. Correctness
 * fixes baked in vs. the old regex path:
 *   - cheerio (htmlparser2) parses real-world/malformed HTML and decodes
 *     entities, handling any attribute order and unquoted attributes
 *     (P-06, L-06, P-05 hreflang, meta/OG/Twitter reverse order, RB-04).
 *   - title stored verbatim; cleaned form is separate (P-01).
 *   - all canonicals collected (CN-01), resolved to absolute (CN-02).
 *   - robots meta parsed into tokens incl. `none`, plus name="googlebot" (RB-04/05/06).
 *   - JSON-LD: CDATA/comment wrappers stripped, whole arrays + nested @graph
 *     walked, malformed blocks flagged not silently dropped (P-02, P-03).
 *   - lazy images (data-src etc.) captured, data: placeholders skipped (L-01).
 *   - heading hierarchy validated in document order (P-04).
 *   - accessibility form-label / tabindex counts computed from the HTML, so
 *     they work on the HTTP path too (J-02).
 */

export interface ParsedHtml extends Partial<ScanResult> {
  /** Meta-derived robots signals, for the caller to merge with X-Robots-Tag. */
  meta_noindex: boolean;
  meta_nofollow: boolean;
}

/** Brand/suffix noise stripped for an optional display title (never stored as `title`). */
export function deriveCleanTitle(title: string): string {
  if (!title) return "";
  const siteNamePatterns = [
    /\s*[|–—]\s*(?:Official\s+)?(?:Site|Website|Home|Shop|Store|Online).*$/i,
    /\s*[|–—]\s*(?:Buy|Order|Get|Shop)\s+.*$/i,
    /\s*[|–—]\s*(?:Free Shipping|Fast Delivery).*$/i,
  ];
  let cleaned = title.trim();
  for (const pattern of siteNamePatterns) cleaned = cleaned.replace(pattern, "");
  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * True when a Content-Type names an HTML document we should parse (E-03).
 * Accepts `text/html` and `application/xhtml+xml` (XHTML served by some CMSes
 * and app frameworks); everything else (PDF, image, JSON, RSS/Atom, plain
 * text …) is a non-HTML resource (S-02).
 */
export function isHtmlContentType(contentType: string | undefined | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/** Pull the `charset=` label out of a Content-Type value, if present. */
function charsetFromContentType(contentType: string | undefined | null): string | null {
  if (!contentType) return null;
  const m = /charset\s*=\s*["']?([^"';,\s]+)/i.exec(contentType);
  return m ? m[1].trim() : null;
}

/**
 * Decode a fetched HTML body to a string honouring its declared character set
 * (P-07). `response.text()` always assumes UTF-8, so a page served as
 * windows-1252 / ISO-8859-1 / Shift_JIS comes back as mojibake and every
 * downstream check (title, keywords, readability) is corrupted. We read the
 * raw bytes and decode with the charset from, in order: the Content-Type
 * header, a `<meta charset>` / `<meta http-equiv>` in the first 1 KB, else
 * UTF-8. An unknown/invalid label falls back to UTF-8 rather than throwing.
 */
export function decodeHtmlBody(
  buf: Uint8Array,
  contentTypeHeader?: string | null,
): string {
  let charset = charsetFromContentType(contentTypeHeader);
  if (!charset) {
    // Peek the head as Latin-1 (every byte maps 1:1) to read a meta charset
    // without first guessing the encoding.
    const head = new TextDecoder("latin1").decode(buf.subarray(0, 1024));
    charset =
      charsetFromContentType(
        /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/i
          .exec(head)?.[0],
      ) ||
      /<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i.exec(head)?.[1] ||
      null;
  }
  const label = (charset || "utf-8").toLowerCase().trim();
  try {
    // TextDecoder maps iso-8859-1→windows-1252 etc. per the WHATWG Encoding
    // standard; it throws RangeError on a label it doesn't know.
    return new TextDecoder(label === "utf8" ? "utf-8" : label).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** Parse a meta-robots / X-Robots-Tag directive list into noindex/nofollow. */
export function parseRobotsContent(content: string | undefined | null): {
  noindex: boolean;
  nofollow: boolean;
} {
  if (!content) return { noindex: false, nofollow: false };
  const tokens = content.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const has = (t: string) => tokens.includes(t);
  // `none` == noindex, nofollow (RB-05).
  const none = has("none");
  return {
    noindex: none || has("noindex"),
    nofollow: none || has("nofollow"),
  };
}

/** Recursively collect every schema.org @type in a parsed JSON-LD node (P-02). */
export function collectSchemaTypes(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, acc);
    return acc;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (t) {
      const types = Array.isArray(t) ? t : [t];
      for (const x of types) if (typeof x === "string") acc.push(x);
    }
    if (Array.isArray(obj["@graph"])) collectSchemaTypes(obj["@graph"], acc);
  }
  return acc;
}

/** Strip HTML-comment and CDATA wrappers some CMSs put around JSON-LD (P-03). */
function unwrapJsonLd(raw: string): string {
  let s = raw.trim();
  // <!-- ... -->
  if (s.startsWith("<!--")) s = s.replace(/^<!--/, "").replace(/-->$/, "").trim();
  // //<![CDATA[ ... //]]>  or  /*<![CDATA[*/ ... /*]]>*/  or  <![CDATA[ ... ]]>
  s = s
    .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, "")
    .replace(/^\/\/\s*<!\[CDATA\[/, "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\/\*\s*\]\]>\s*\*\/$/, "")
    .replace(/\/\/\s*\]\]>$/, "")
    .replace(/\]\]>$/, "")
    .trim();
  return s;
}

const IMAGE_FORMAT_MAP: Record<string, string> = {
  jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp",
  avif: "avif", svg: "svg", ico: "ico", bmp: "bmp", tiff: "tiff", tif: "tiff",
};

export function deriveImageFormat(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const extMatch = pathname.match(/\.([a-z0-9]+)(?:\?.*)?$/);
    if (extMatch) return IMAGE_FORMAT_MAP[extMatch[1]] || extMatch[1];
  } catch { /* invalid URL */ }
  return "";
}

/** URL-shape SEO issues (pure; mirrors the old Scanner.analyzeUrlIssues). */
export function analyzeUrlIssues(url: string): string[] {
  const issues: string[] = [];
  try {
    const parsed = new URL(url);
    if (/[A-Z]/.test(parsed.pathname)) issues.push("URL contains uppercase letters");
    if (parsed.pathname.includes("_")) issues.push("URL contains underscores instead of hyphens");
    if (url.length > 115) issues.push(`URL is excessively long (${url.length} characters, recommended max 115)`);
    if (parsed.search) issues.push("URL contains dynamic query parameters");
  } catch { /* invalid */ }
  return issues;
}

/**
 * Validate heading hierarchy in DOCUMENT ORDER (P-04): flags a skip when a
 * heading jumps more than one level deeper than the previous heading.
 */
export function checkHeadingOrder(levels: number[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1];
    const cur = levels[i];
    if (cur - prev > 1) {
      const skipped: string[] = [];
      for (let s = prev + 1; s < cur; s++) skipped.push(`H${s}`);
      issues.push(`Heading level skipped: H${prev} to H${cur} (missing ${skipped.join(", ")})`);
    }
  }
  return { valid: issues.length === 0, issues };
}

const NON_NAV_SCHEMES = [
  "javascript:", "mailto:", "tel:", "data:", "ftp:", "sms:", "blob:",
  "file:", "geo:", "whatsapp:", "skype:", "viber:", "callto:",
];

const LAZY_SRC_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy"];

function pickImageSrc($el: ReturnType<CheerioAPI>): string | null {
  const rawSrc = ($el.attr("src") || "").trim();
  const isPlaceholder = rawSrc === "" || rawSrc.startsWith("data:");
  if (!isPlaceholder) return rawSrc;
  // Lazy-loaded: prefer a real data-* source over a data: placeholder (L-01).
  for (const attr of LAZY_SRC_ATTRS) {
    const v = ($el.attr(attr) || "").trim();
    if (v && !v.startsWith("data:")) return v;
  }
  const dataSrcset = ($el.attr("data-srcset") || $el.attr("srcset") || "").trim();
  if (dataSrcset) {
    const first = dataSrcset.split(",")[0]?.trim().split(/\s+/)[0];
    if (first && !first.startsWith("data:")) return first;
  }
  return rawSrc || null;
}

export function extractFromHtml(html: string, finalUrl: string): ParsedHtml {
  const $ = load(html);
  const urlProcessor = new UrlProcessor(finalUrl);
  const resolve = (href: string) => urlProcessor.resolve(finalUrl, href);

  const out: ParsedHtml = {
    meta_noindex: false,
    meta_nofollow: false,
    open_graph: {},
    twitter_card: {},
    structured_data: [],
    schema_types: [],
    internal_links: [],
    external_links: [],
    images: [],
    hreflang_tags: [],
  };

  // --- Title (verbatim; P-01) with fallback chain for title-less pages. ---
  const rawTitle = $("title").first().text().trim();
  let title = rawTitle;
  if (!title) title = ($('meta[property="og:title" i]').attr("content") || "").trim();
  if (!title) title = $("h1").first().text().trim();
  out.title = title;
  out.title_cleaned = deriveCleanTitle(title);

  // --- Meta description (any attribute order via selector). ---
  const metaDesc = $('meta[name="description" i]').attr("content");
  if (metaDesc != null) out.meta_description = metaDesc.trim();

  // --- Headings (per level + document order for hierarchy; P-04). ---
  const byLevel: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const order: number[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const level = Number((el as any).tagName?.[1] || (el as any).name?.[1]);
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!level) return;
    order.push(level);
    if (text.length > 0) byLevel[level].push(text);
  });
  out.h1s = byLevel[1]; out.h2s = byLevel[2]; out.h3s = byLevel[3];
  out.h4s = byLevel[4]; out.h5s = byLevel[5]; out.h6s = byLevel[6];
  const hierarchy = checkHeadingOrder(order);
  out.heading_hierarchy_valid = hierarchy.valid;
  out.heading_hierarchy_issues = hierarchy.issues;

  // --- Favicon (any <link rel> containing "icon"). ---
  const iconLink = $("link[rel]").filter((_, el) =>
    /icon/i.test($(el).attr("rel") || ""),
  ).first();
  if (iconLink.length) {
    const href = iconLink.attr("href");
    if (href) out.favicon_url = resolve(href) || href;
  }

  // --- Canonicals: collect all, resolve absolute (CN-01, CN-02). ---
  const canonicals: string[] = [];
  $('link[rel="canonical" i]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) canonicals.push(resolve(href) || href);
  });
  const distinctCanonicals = [...new Set(canonicals)];
  out.canonical_url = distinctCanonicals[0] ?? null;
  if (distinctCanonicals.length > 0) out.canonical_urls = distinctCanonicals;

  // --- Robots meta (robots + googlebot), tokens incl. `none` (RB-04/05/06). ---
  const robots = parseRobotsContent($('meta[name="robots" i]').attr("content"));
  const googlebot = parseRobotsContent($('meta[name="googlebot" i]').attr("content"));
  out.meta_noindex = robots.noindex || googlebot.noindex;
  out.meta_nofollow = robots.nofollow || googlebot.nofollow;

  // --- Open Graph / Twitter (any attribute order via selectors). ---
  $('meta[property^="og:" i]').each((_, el) => {
    const prop = ($(el).attr("property") || "").slice(3);
    const content = $(el).attr("content");
    if (prop && content != null) (out.open_graph as Record<string, string>)[prop] = content;
  });
  $('meta[name^="twitter:" i]').each((_, el) => {
    const name = ($(el).attr("name") || "").slice(8);
    const content = $(el).attr("content");
    if (name && content != null) (out.twitter_card as Record<string, string>)[name] = content;
  });

  // --- JSON-LD: unwrap CDATA/comments, walk fully, flag malformed (P-02/P-03). ---
  const schemaTypes: string[] = [];
  $('script[type="application/ld+json" i]').each((_, el) => {
    const raw = unwrapJsonLd($(el).text());
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      (out.structured_data as unknown[]).push(data);
      collectSchemaTypes(data, schemaTypes);
    } catch {
      out.has_invalid_structured_data = true;
    }
  });
  out.schema_types = [...new Set(schemaTypes)];

  // --- Scripts / stylesheets. ---
  const scriptSrcs: string[] = [];
  $("script[src]").each((_, el) => { const s = $(el).attr("src"); if (s) scriptSrcs.push(s); });
  out.script_srcs = scriptSrcs;
  out.js_count = scriptSrcs.length;
  const stylesheetHrefs: string[] = [];
  $('link[rel="stylesheet" i][href]').each((_, el) => {
    const h = $(el).attr("href"); if (h) stylesheetHrefs.push(h);
  });
  out.stylesheet_hrefs = stylesheetHrefs;
  out.css_count = stylesheetHrefs.length;

  // --- Viewport. ---
  out.has_viewport_meta = $('meta[name="viewport" i]').length > 0;

  // --- Links (unquoted hrefs handled by the parser; L-06). ---
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const hrefLower = href.toLowerCase();
    if (!href || href === "#" || NON_NAV_SCHEMES.some((s) => hrefLower.startsWith(s))) return;
    const resolved = resolve(href);
    if (!resolved) return;
    const rel = ($(el).attr("rel") || "").split(/\s+/).filter(Boolean);
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const linkData = { url: resolved, anchor_text: text || href, rel_attributes: rel };
    if (urlProcessor.isInternal(resolved)) out.internal_links!.push(linkData);
    else out.external_links!.push(linkData);
  });

  // --- Images (lazy data-src handled; L-01). ---
  $("img").each((_, el) => {
    const $el = $(el);
    const src = pickImageSrc($el);
    if (!src) return;
    const resolved = resolve(src);
    if (!resolved) return;
    const altAttr = $el.attr("alt");
    const altValue = altAttr ?? "";
    const altState: "absent" | "empty" | "present" =
      altAttr === undefined ? "absent" : altValue.trim() === "" ? "empty" : "present";
    const width = parseInt($el.attr("width") || "", 10);
    const height = parseInt($el.attr("height") || "", 10);
    const srcset = $el.attr("srcset") || $el.attr("data-srcset");
    out.images!.push({
      src: resolved,
      alt: altValue,
      alt_state: altState,
      dimensions: {
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
      },
      loading: $el.attr("loading") || "",
      srcset: srcset || undefined,
      format: deriveImageFormat(resolved),
    });
  });

  // --- Mixed content (https page referencing http resources). ---
  if (finalUrl.startsWith("https://")) {
    const sel = 'img[src^="http:"], script[src^="http:"], link[href^="http:"], ' +
      'iframe[src^="http:"], video[src^="http:"], audio[src^="http:"], ' +
      'source[src^="http:"], object[data^="http:"], embed[src^="http:"]';
    out.has_mixed_content = $(sel).length > 0;
  } else {
    out.has_mixed_content = false;
  }

  // --- hreflang (any attribute order; P-05). ---
  $('link[rel="alternate" i][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang") || "";
    const href = $(el).attr("href") || "";
    if (lang && href) out.hreflang_tags!.push({ lang, url: resolve(href) || href });
  });

  // --- URL issues. ---
  out.url_issues = analyzeUrlIssues(finalUrl);

  // --- Contact form. ---
  out.has_contact_form = detectContactForm($);

  // --- CLS risk: images missing explicit width/height. ---
  out.cls_risk_images = $("img").filter((_, el) =>
    !($(el).attr("width") && $(el).attr("height")),
  ).length;

  // --- Accessibility (computed from HTML, so it works on the HTTP path; J-02). ---
  out.accessibility = extractAccessibility($);

  // --- Cookie consent. ---
  out.has_cookie_consent =
    /cookie[-_]?(banner|consent|notice|policy|popup)|gdpr|onetrust|cookiebot|cc-banner/i.test(html) ||
    $('[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="gdpr" i], [id*="onetrust" i], [class*="cc-banner" i]').length > 0;

  // --- Resource hints. ---
  const hints = (rel: string) => {
    const urls: string[] = [];
    $(`link[rel="${rel}" i][href]`).each((_, el) => { const h = $(el).attr("href"); if (h) urls.push(h); });
    return urls;
  };
  out.resource_hints = {
    preconnect: hints("preconnect"),
    preload: hints("preload"),
    prefetch: hints("prefetch"),
    dns_prefetch: hints("dns-prefetch"),
  };

  // --- Content text, word/content counts, lead paragraph, metrics. ---
  const { contentText, fullText, leadParagraphWords } = extractContentText($);
  out.content_length = fullText.length;
  out.word_count = countWords(contentText);
  out.lead_paragraph_words = leadParagraphWords;
  out.content_hash = computeContentHash(contentText);
  out.readability_score = computeReadabilityScore(contentText);
  out.keywords = extractKeywords(contentText);

  return out;
}

function detectContactForm($: CheerioAPI): boolean {
  let found = false;
  $("form").each((_, form) => {
    if (found) return;
    const $f = $(form);
    const hasEmail = $f.find('input[type="email" i], input[name*="email" i], input[autocomplete="email" i]').length > 0;
    const hasTextarea = $f.find("textarea").length > 0;
    const hasPhone = $f.find('input[type="tel" i], input[name*="phone" i]').length > 0;
    const hasName = $f.find('input[name*="name" i], input[autocomplete="name" i]').length > 0;
    if (hasEmail && (hasTextarea || hasPhone || hasName)) found = true;
  });
  return found;
}

function extractAccessibility($: CheerioAPI): NonNullable<ScanResult["accessibility"]> {
  // Form labels (J-02): count inputs/selects/textareas with no associated label.
  let missingLabels = 0;
  $("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const type = ($el.attr("type") || "").toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button") return;
    const id = $el.attr("id");
    const hasLabel =
      (id && $(`label[for="${cssEscape(id)}"]`).length > 0) ||
      $el.closest("label").length > 0 ||
      !!$el.attr("aria-label") ||
      !!$el.attr("aria-labelledby");
    if (!hasLabel) missingLabels++;
  });

  const landmarks = new Set<string>();
  $('nav, main, header, footer, aside, [role="navigation"], [role="main"], [role="banner"], [role="contentinfo"], [role="complementary"]').each((_, el) => {
    const tag = (((el as any).tagName || (el as any).name) || "").toLowerCase();
    if (["nav", "main", "header", "footer", "aside"].includes(tag)) landmarks.add(tag);
    else {
      const role = $(el).attr("role");
      if (role) landmarks.add(role);
    }
  });

  const hasSkipNav = $('a[href^="#"]').toArray().some((a) => {
    const text = ($(a).text() || "").toLowerCase();
    return text.includes("skip") || text.includes("jump to");
  });

  const tabindexMisuse = $("[tabindex]").filter((_, el) =>
    parseInt($(el).attr("tabindex") || "0", 10) > 0,
  ).length;

  return {
    html_lang: $("html").attr("lang") || undefined,
    form_labels_missing: missingLabels,
    aria_landmarks: [...landmarks],
    has_skip_nav: hasSkipNav,
    tabindex_misuse: tabindexMisuse,
  };
}

/** Minimal CSS.escape for id attribute selectors (Node has no global CSS). */
function cssEscape(value: string): string {
  return value.replace(/["\\\]\[#.:>+~*^$|=()\s]/g, "\\$&");
}

/**
 * Content-area text, excluding nav/header/footer/aside/form boilerplate, so word
 * count / readability / content hash reflect real content — not a shared
 * header+footer that reads as ~150 words on every page.
 */
function extractContentText($: CheerioAPI): {
  contentText: string;
  fullText: string;
  leadParagraphWords: number;
} {
  const $clean = load($.html());
  $clean("script, style").remove();

  const fullText = ($clean("body").text() || $clean.root().text())
    .replace(/\s+/g, " ").trim();

  let $content = $clean("main").first();
  if ($content.length === 0) $content = $clean("article").first();
  if ($content.length === 0) $content = $clean("body");
  // Clone so removing boilerplate doesn't disturb traversal.
  const $scope = $content.clone();
  $scope.find("nav, header, footer, aside, form").remove();
  const contentText = $scope.text().replace(/\s+/g, " ").trim();

  // Lead paragraph (AEO answer block): first <p> after the first <h1> in scope;
  // if there is no <h1>, the first <p> overall.
  let sawH1 = false;
  let leadText: string | null = null;
  $scope.find("h1, p").each((_, el) => {
    if (leadText !== null) return;
    const tag = (((el as any).tagName || (el as any).name) || "").toLowerCase();
    if (tag === "h1") { sawH1 = true; return; }
    if (tag === "p" && (sawH1 || !$scope.find("h1").length)) {
      leadText = $(el).text().replace(/\s+/g, " ").trim();
    }
  });
  const leadParagraphWords = leadText ? countWords(leadText) : 0;

  return { contentText, fullText, leadParagraphWords };
}
