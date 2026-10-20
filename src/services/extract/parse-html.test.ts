import { describe, it, expect } from "vitest";
import {
  extractFromHtml,
  parseRobotsContent,
  collectSchemaTypes,
  deriveCleanTitle,
  checkHeadingOrder,
  isHtmlContentType,
  decodeHtmlBody,
  parseLinkHeaderCanonical,
} from "./parse-html";

const BASE = "https://example.com/page";
const parse = (body: string, url = BASE) =>
  extractFromHtml(`<!doctype html><html><head></head><body>${body}</body></html>`, url);
const doc = (head: string, body = "", url = BASE) =>
  extractFromHtml(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, url);

describe("isHtmlContentType (E-03/S-02)", () => {
  it("accepts text/html with and without a charset param", () => {
    expect(isHtmlContentType("text/html")).toBe(true);
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("TEXT/HTML;charset=ISO-8859-1")).toBe(true);
  });
  it("E-03: accepts application/xhtml+xml", () => {
    expect(isHtmlContentType("application/xhtml+xml")).toBe(true);
    expect(isHtmlContentType("application/xhtml+xml; charset=utf-8")).toBe(true);
  });
  it("S-02: rejects non-HTML resources", () => {
    expect(isHtmlContentType("application/pdf")).toBe(false);
    expect(isHtmlContentType("image/png")).toBe(false);
    expect(isHtmlContentType("application/json")).toBe(false);
    expect(isHtmlContentType("application/rss+xml")).toBe(false);
    expect(isHtmlContentType("text/plain")).toBe(false);
    expect(isHtmlContentType("")).toBe(false);
    expect(isHtmlContentType(null)).toBe(false);
    expect(isHtmlContentType(undefined)).toBe(false);
  });
});

describe("decodeHtmlBody charset handling (P-07)", () => {
  // 0x92 is a curly apostrophe (’ U+2019) in windows-1252, invalid in UTF-8.
  const curlyByte = () => new Uint8Array([0x92]);

  it("honours a windows-1252 charset from the Content-Type header", () => {
    expect(decodeHtmlBody(curlyByte(), "text/html; charset=windows-1252")).toBe("’");
  });

  it("honours ISO-8859-1 (mapped to windows-1252 per WHATWG)", () => {
    // 0xE9 = é in both ISO-8859-1 and windows-1252.
    expect(decodeHtmlBody(new Uint8Array([0xe9]), "text/html; charset=iso-8859-1")).toBe("é");
  });

  it("falls back to a <meta charset> when the header says nothing", () => {
    const bytes = Buffer.concat([
      Buffer.from('<meta charset="windows-1252"><title>', "ascii"),
      Buffer.from([0x92]),
      Buffer.from("</title>", "ascii"),
    ]);
    expect(decodeHtmlBody(new Uint8Array(bytes), "text/html")).toContain("’");
  });

  it("defaults to UTF-8 when nothing is declared", () => {
    expect(decodeHtmlBody(new Uint8Array(Buffer.from("café", "utf-8")))).toBe("café");
  });

  it("falls back to UTF-8 on an unknown charset label instead of throwing", () => {
    expect(decodeHtmlBody(new Uint8Array(Buffer.from("café", "utf-8")), "text/html; charset=x-bogus")).toBe("café");
  });

  it("E-02: caps the bytes parsed when maxBytes is given", () => {
    const big = new Uint8Array(Buffer.from("A".repeat(100), "ascii"));
    expect(decodeHtmlBody(big, "text/html", 10)).toBe("AAAAAAAAAA");
    // Under the cap, the whole body is returned unchanged.
    expect(decodeHtmlBody(big, "text/html", 1000).length).toBe(100);
  });
});

describe("parseLinkHeaderCanonical (CN-05)", () => {
  const base = "https://example.com/page";
  it("extracts an absolute canonical from the Link header", () => {
    expect(
      parseLinkHeaderCanonical('<https://example.com/real>; rel="canonical"', base),
    ).toBe("https://example.com/real");
  });
  it("resolves a relative canonical against the page URL", () => {
    expect(parseLinkHeaderCanonical("</real>; rel=canonical", base)).toBe(
      "https://example.com/real",
    );
  });
  it("picks the canonical out of a multi-value Link header", () => {
    const header =
      '<https://example.com/style.css>; rel=preload; as=style, <https://example.com/real>; rel="canonical"';
    expect(parseLinkHeaderCanonical(header, base)).toBe("https://example.com/real");
  });
  it("matches canonical within a space-separated rel set", () => {
    expect(
      parseLinkHeaderCanonical('<https://example.com/real>; rel="canonical next"', base),
    ).toBe("https://example.com/real");
  });
  it("returns null when there is no canonical rel, or no header", () => {
    expect(parseLinkHeaderCanonical('<https://example.com/x>; rel="next"', base)).toBeNull();
    expect(parseLinkHeaderCanonical(null, base)).toBeNull();
    expect(parseLinkHeaderCanonical("", base)).toBeNull();
  });
});

describe("parseRobotsContent", () => {
  it("RB-05: 'none' means noindex + nofollow", () => {
    expect(parseRobotsContent("none")).toEqual({ noindex: true, nofollow: true });
  });
  it("parses token lists in any order/case", () => {
    expect(parseRobotsContent("NoFollow, NOINDEX")).toEqual({ noindex: true, nofollow: true });
  });
  it("empty/undefined is permissive", () => {
    expect(parseRobotsContent(undefined)).toEqual({ noindex: false, nofollow: false });
  });
});

describe("meta robots (RB-04/05/06)", () => {
  it("RB-04: detects reversed attribute order (content before name)", () => {
    const r = doc(`<meta content="noindex,nofollow" name="robots">`);
    expect(r.meta_noindex).toBe(true);
    expect(r.meta_nofollow).toBe(true);
  });
  it("RB-06: honours name=googlebot noindex", () => {
    const r = doc(`<meta name="googlebot" content="noindex">`);
    expect(r.meta_noindex).toBe(true);
  });
  it("no robots meta leaves indexable", () => {
    expect(doc(``).meta_noindex).toBe(false);
  });
});

describe("title (P-01)", () => {
  it("stores the verbatim <title>, entity-decoded, NOT brand-stripped", () => {
    const r = doc(`<title>Premium Hiking Boots | Official Store</title>`);
    expect(r.title).toBe("Premium Hiking Boots | Official Store");
    // cleaned form is separate and never used as the stored title
    expect(r.title_cleaned).toBe("Premium Hiking Boots");
  });
  it("decodes entities in the title", () => {
    expect(doc(`<title>Tom &amp; Jerry</title>`).title).toBe("Tom & Jerry");
  });
  it("falls back to og:title then h1 when <title> is absent", () => {
    expect(doc(`<meta property="og:title" content="OG Name">`).title).toBe("OG Name");
    expect(parse(`<h1>Heading Title</h1>`).title).toBe("Heading Title");
  });
  it("deriveCleanTitle only strips recognised suffixes", () => {
    expect(deriveCleanTitle("Blue Shoes | Free Shipping")).toBe("Blue Shoes");
    expect(deriveCleanTitle("About Our Team")).toBe("About Our Team");
  });
});

describe("meta description / OG / twitter (reverse order)", () => {
  it("captures description regardless of attribute order", () => {
    expect(doc(`<meta content="Desc here" name="description">`).meta_description).toBe("Desc here");
  });
  it("captures OG and twitter tags in any order", () => {
    const r = doc(
      `<meta content="https://img" property="og:image">` +
      `<meta name="twitter:card" content="summary">`,
    );
    expect(r.open_graph).toMatchObject({ image: "https://img" });
    expect(r.twitter_card).toMatchObject({ card: "summary" });
  });
});

describe("JSON-LD (P-02/P-03)", () => {
  it("P-02: collects every @type from a top-level array", () => {
    const r = doc(
      `<script type="application/ld+json">[{"@type":"Product"},{"@type":"BreadcrumbList"},{"@type":"FAQPage"}]</script>`,
    );
    expect(r.schema_types).toEqual(expect.arrayContaining(["Product", "BreadcrumbList", "FAQPage"]));
    expect(r.has_invalid_structured_data).toBeFalsy();
  });
  it("P-02: recurses into @graph and nested arrays", () => {
    const r = doc(
      `<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":["WebSite","CreativeWork"]}]}</script>`,
    );
    expect(r.schema_types).toEqual(expect.arrayContaining(["Organization", "WebSite", "CreativeWork"]));
  });
  it("P-03: parses JSON-LD wrapped in CDATA", () => {
    const r = doc(
      `<script type="application/ld+json">//<![CDATA[\n{"@type":"Organization"}\n//]]></script>`,
    );
    expect(r.schema_types).toContain("Organization");
    expect(r.has_invalid_structured_data).toBeFalsy();
  });
  it("P-03: flags malformed JSON-LD rather than treating it as absent", () => {
    const r = doc(`<script type="application/ld+json">{ not valid json }</script>`);
    expect(r.has_invalid_structured_data).toBe(true);
    expect(r.schema_types).toEqual([]);
  });
  it("collectSchemaTypes handles string and array @type", () => {
    expect(collectSchemaTypes({ "@type": "Thing" })).toEqual(["Thing"]);
    expect(collectSchemaTypes({ "@type": ["A", "B"] })).toEqual(["A", "B"]);
  });
});

describe("heading hierarchy (P-04)", () => {
  it("flags out-of-order H1->H3->H2 using document order", () => {
    expect(checkHeadingOrder([1, 3, 2]).valid).toBe(false);
    const r = parse(`<h1>a</h1><h3>b</h3><h2>c</h2>`);
    expect(r.heading_hierarchy_valid).toBe(false);
  });
  it("accepts a well-ordered document", () => {
    expect(parse(`<h1>a</h1><h2>b</h2><h3>c</h3>`).heading_hierarchy_valid).toBe(true);
  });
  it("flags a skip from H1 to H4", () => {
    expect(checkHeadingOrder([1, 4]).valid).toBe(false);
  });
});

describe("canonicals (CN-01/CN-02)", () => {
  it("CN-01: collects conflicting canonicals", () => {
    const r = doc(`<link rel="canonical" href="https://example.com/a"><link rel="canonical" href="https://example.com/b">`);
    expect(r.canonical_urls).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
  it("CN-02: resolves a relative canonical to absolute", () => {
    const r = doc(`<link rel="canonical" href="/a">`);
    expect(r.canonical_url).toBe("https://example.com/a");
  });
});

describe("hreflang (P-05)", () => {
  it("captures hreflang regardless of attribute order", () => {
    const r = doc(
      `<link href="https://example.com/fr" hreflang="fr" rel="alternate">` +
      `<link rel="alternate" hreflang="de" href="https://example.com/de">`,
    );
    const langs = (r.hreflang_tags || []).map((t) => t.lang).sort();
    expect(langs).toEqual(["de", "fr"]);
  });
});

describe("images (L-01, alt_state, P-09)", () => {
  it("L-01: captures lazy data-src images and skips data: placeholders", () => {
    const r = parse(
      `<img data-src="https://example.com/real.jpg">` +
      `<img src="data:image/gif;base64,R0lGOD" data-src="/lazy.webp">`,
    );
    expect(r.images).toHaveLength(2);
    expect(r.images![0].src).toBe("https://example.com/real.jpg");
    expect(r.images![1].src).toBe("https://example.com/lazy.webp");
    expect(r.images![1].format).toBe("webp");
  });
  it("distinguishes absent / empty / present alt", () => {
    const r = parse(
      `<img src="/a.jpg">` +
      `<img src="/b.jpg" alt="">` +
      `<img src="/c.jpg" alt="A cat">`,
    );
    expect(r.images!.map((i) => i.alt_state)).toEqual(["absent", "empty", "present"]);
  });
  it("P-09: keeps a multi-word alt intact", () => {
    const r = parse(`<img src="/a.jpg" alt="She said hello to everyone">`);
    expect(r.images![0].alt).toBe("She said hello to everyone");
  });
});

describe("links (L-06)", () => {
  it("L-06: extracts an unquoted href", () => {
    const r = parse(`<a href=/products>Shop</a>`);
    expect(r.internal_links).toHaveLength(1);
    expect(r.internal_links![0].url).toBe("https://example.com/products");
  });
  it("classifies internal vs external and skips non-nav schemes", () => {
    const r = parse(
      `<a href="/about">About</a>` +
      `<a href="https://other.com/x">Ext</a>` +
      `<a href="mailto:a@b.com">Mail</a>` +
      `<a href="tel:+123">Call</a>`,
    );
    expect(r.internal_links).toHaveLength(1);
    expect(r.external_links).toHaveLength(1);
  });
  it("captures rel attributes", () => {
    const r = parse(`<a href="https://other.com" rel="nofollow noopener">x</a>`);
    expect(r.external_links![0].rel_attributes).toEqual(["nofollow", "noopener"]);
  });
});

describe("accessibility on the HTTP path (J-02)", () => {
  it("J-02: counts unlabeled form fields and positive tabindex from HTML", () => {
    const r = parse(
      `<form>` +
        `<input type="text" name="unlabeled">` +
        `<label for="e">Email</label><input id="e" type="email">` +
        `<input type="text" aria-label="Search">` +
        `<div tabindex="5">x</div>` +
      `</form>`,
    );
    // unlabeled text input only; the labeled + aria-labeled ones are fine
    expect(r.accessibility!.form_labels_missing).toBe(1);
    expect(r.accessibility!.tabindex_misuse).toBe(1);
  });
  it("reads html lang and landmarks", () => {
    const r = extractFromHtml(
      `<html lang="en"><body><nav></nav><main></main></body></html>`,
      BASE,
    );
    expect(r.accessibility!.html_lang).toBe("en");
    expect(r.accessibility!.aria_landmarks).toEqual(expect.arrayContaining(["nav", "main"]));
  });
});

describe("content extraction", () => {
  it("counts words from main content, excluding nav/header/footer", () => {
    const r = parse(
      `<header>Site Logo Home About Contact</header>` +
      `<main><h1>Title</h1><p>This is the real article body with several meaningful words here.</p></main>` +
      `<footer>Copyright 2026 All rights reserved company address</footer>`,
    );
    // Only the main content words are counted (header/footer excluded)
    expect(r.word_count).toBeGreaterThan(8);
    expect(r.word_count).toBeLessThan(16);
    expect(r.lead_paragraph_words).toBe(11);
  });
  it("produces a stable content hash for identical content", () => {
    const a = parse(`<main><p>Hello world content here</p></main>`);
    const b = parse(`<main><p>Hello world content here</p></main>`);
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.content_hash).toHaveLength(64);
  });
});

describe("mixed content", () => {
  it("flags http resources on an https page", () => {
    expect(parse(`<img src="http://insecure.com/a.jpg">`).has_mixed_content).toBe(true);
  });
  it("is false on an http page", () => {
    expect(parse(`<img src="http://x/a.jpg">`, "http://example.com/p").has_mixed_content).toBe(false);
  });
});
