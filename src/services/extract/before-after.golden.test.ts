import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractFromHtml, decodeHtmlBody } from "./parse-html";

/**
 * Deterministic OFFLINE golden tests over real pages captured once from three
 * live sites (WordPress / Shopify / Next.js). The HTML + response headers were
 * saved under __fixtures__/before-after/ and the sites are NEVER re-fetched:
 * these tests read only the saved bytes, so they are reproducible in CI.
 *
 * They pin the NEW cheerio extractor (extractFromHtml) on the key fields the
 * Stage-0 audit flagged (P-01 verbatim title + entity decode, P-07 charset
 * decode, CN-01/CN-02 canonical collection + absolutisation, P-03 structured
 * data, J-02 html lang). See docs/audit/07-before-after.md for the old-vs-new
 * diff these values come from.
 */

const DIR = join(__dirname, "__fixtures__", "before-after");

/** Load a fixture exactly as the crawler would: raw bytes decoded by charset. */
function loadFixture(base: string, finalUrl: string) {
  const bytes = readFileSync(join(DIR, `${base}.html`));
  const headers = readFileSync(join(DIR, `${base}.headers.txt`), "utf8");
  // Use the LAST Content-Type header (final response after any redirects).
  const ct =
    headers
      .split(/\r?\n/)
      .reverse()
      .find((l) => /^content-type:/i.test(l))
      ?.replace(/^content-type:\s*/i, "")
      .trim() || null;
  const html = decodeHtmlBody(new Uint8Array(bytes), ct);
  return { html, contentType: ct, result: extractFromHtml(html, finalUrl) };
}

/** No mojibake / replacement characters leaked through decoding (P-07). */
function assertCleanDecode(s: string | undefined) {
  expect(s ?? "").not.toMatch(/�/);
}

describe("before/after golden: WordPress (covenantsecurity.com.au)", () => {
  const { contentType, result } = loadFixture(
    "wordpress-covenant-home",
    "https://covenantsecurity.com.au/",
  );

  it("captured as UTF-8 HTML", () => {
    expect(contentType).toMatch(/text\/html/i);
    expect(contentType).toMatch(/charset=utf-8/i);
  });

  it("P-01: stores the verbatim title with entities decoded (&amp; -> &)", () => {
    expect(result.title).toBe(
      "Covenant Security Solutions - Alarms, Access Control & CCTV",
    );
    expect(result.title).toContain("&");
    assertCleanDecode(result.title);
  });

  it("CN-01/CN-02: single canonical, resolved absolute", () => {
    expect(result.canonical_url).toBe("https://covenantsecurity.com.au/");
    expect(result.canonical_urls).toEqual(["https://covenantsecurity.com.au/"]);
  });

  it("P-04: exactly one H1", () => {
    expect(result.h1s).toHaveLength(1);
  });

  it("P-03: walks @graph for all schema types", () => {
    expect(result.schema_types).toEqual(
      expect.arrayContaining([
        "Organization",
        "WebSite",
        "WebPage",
        "LocalBusiness",
        "BreadcrumbList",
      ]),
    );
    expect(result.has_invalid_structured_data).not.toBe(true);
  });

  it("excludes the <noscript> Facebook tracking pixel from images", () => {
    // OLD regex pulled facebook.com/tr out of <noscript> and flagged it a
    // missing-alt content image; the DOM parser scopes it out.
    expect(
      (result.images ?? []).some((i) => /facebook\.com\/tr/.test(i.src)),
    ).toBe(false);
  });

  it("J-02: captures html lang on the HTTP path", () => {
    expect(result.accessibility?.html_lang).toBe("en-US");
  });
});

describe("before/after golden: Shopify (goingdark.com.au)", () => {
  const { contentType, result } = loadFixture(
    "shopify-goingdark-home",
    "https://goingdark.com.au/",
  );

  it("captured as UTF-8 HTML", () => {
    expect(contentType).toMatch(/text\/html/i);
    expect(contentType).toMatch(/charset=utf-8/i);
  });

  it("P-01: verbatim title", () => {
    expect(result.title).toBe(
      "GoingDark - Your Thermal and Night Vision Experts",
    );
    assertCleanDecode(result.title);
  });

  it("collapses whitespace inside heading text", () => {
    expect(result.h1s).toHaveLength(2);
    // OLD regex left the raw inner newline ("GoingDark\n      GoingDark").
    expect(result.h1s?.[0]).toBe("GoingDark GoingDark");
    expect(result.h1s?.[0]).not.toMatch(/\n/);
  });

  it("CN-01/CN-02: canonical resolved absolute", () => {
    expect(result.canonical_url).toBe("https://goingdark.com.au/");
  });

  it("P-03: Product schema detected", () => {
    expect(result.schema_types).toContain("Product");
    expect(result.has_invalid_structured_data).not.toBe(true);
  });

  it("entity decode in meta description (&amp; -> &)", () => {
    expect(result.meta_description).toContain("&");
    assertCleanDecode(result.meta_description);
  });
});

describe("before/after golden: Next.js (ravenci.solutions)", () => {
  const { contentType, result } = loadFixture(
    "nextjs-ravenci-home",
    "https://ravenci.solutions/",
  );

  it("captured as UTF-8 HTML", () => {
    expect(contentType).toMatch(/text\/html/i);
    expect(contentType).toMatch(/charset=utf-8/i);
  });

  it("P-01: verbatim title (pipe-brand suffix NOT stripped from stored title)", () => {
    expect(result.title).toBe(
      "Custom Website Design Brisbane | RAVENCI Solutions",
    );
    assertCleanDecode(result.title);
  });

  it("CN-02: bare canonical href is resolved to an absolute URL", () => {
    // Source markup: <link rel="canonical" href="https://ravenci.solutions"/>
    // OLD stored it verbatim (no trailing slash); NEW absolutises it.
    expect(result.canonical_url).toBe("https://ravenci.solutions/");
  });

  it("P-04: one H1 with expected text", () => {
    expect(result.h1s).toHaveLength(1);
    expect(result.h1s?.[0]).toBe("Custom websites, engineered to last");
  });

  it("P-03: ProfessionalService / LocalBusiness / WebSite schema", () => {
    expect(result.schema_types).toEqual(
      expect.arrayContaining([
        "ProfessionalService",
        "LocalBusiness",
        "WebSite",
      ]),
    );
    expect(result.has_invalid_structured_data).not.toBe(true);
  });

  it("J-02: captures html lang on the HTTP path", () => {
    expect(result.accessibility?.html_lang).toBe("en-AU");
  });
});
