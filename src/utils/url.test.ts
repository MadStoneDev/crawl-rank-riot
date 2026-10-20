import { describe, it, expect } from "vitest";
import {
  classifyPageType,
  isContentPage,
  isSelfCanonical,
  UrlProcessor,
} from "./url";

const BASE = "https://blubookkeepers.com";

describe("isSelfCanonical (P0.3)", () => {
  it("treats a relative canonical that resolves to the page as self", () => {
    // The DIRT fixture: /, /about, /contact used relative canonicals and were
    // falsely flagged as mismatches.
    expect(isSelfCanonical("/about", "https://thedirtagency.com/about")).toBe(true);
    expect(isSelfCanonical("/", "https://thedirtagency.com/")).toBe(true);
    expect(isSelfCanonical("/contact", "https://thedirtagency.com/contact")).toBe(true);
  });

  it("treats an absolute self canonical as self", () => {
    expect(
      isSelfCanonical(
        "https://thedirtagency.com/newsletter",
        "https://thedirtagency.com/newsletter",
      ),
    ).toBe(true);
  });

  it("ignores trailing slash, host case and fragment", () => {
    expect(isSelfCanonical("/about/", "https://EXAMPLE.com/about")).toBe(true);
    expect(isSelfCanonical("/about#top", "https://example.com/about")).toBe(true);
  });

  it("flags a genuine mismatch", () => {
    expect(isSelfCanonical("/other", "https://example.com/about")).toBe(false);
    expect(
      isSelfCanonical("https://example.com/", "https://example.com/about"),
    ).toBe(false);
  });

  it("returns false for a null/empty canonical", () => {
    expect(isSelfCanonical(null, "https://example.com/about")).toBe(false);
    expect(isSelfCanonical("", "https://example.com/about")).toBe(false);
  });
});

describe("tracking-param stripping (U-04) + self-compare (CN-04)", () => {
  const up = new UrlProcessor(BASE);

  it("U-04: strips the extended click-ID set but keeps real params", () => {
    expect(up.normalize(`${BASE}/p?gbraid=1&wbraid=2&ttclid=3&utm_id=4&id=9`)).toBe(
      `${BASE}/p?id=9`,
    );
  });

  it("U-04: does NOT strip ref by default (per-project, default off)", () => {
    expect(up.normalize(`${BASE}/p?ref=partner`)).toBe(`${BASE}/p?ref=partner`);
  });

  it("U-04: strips ref when the project opts in", () => {
    const upRef = new UrlProcessor(BASE, { stripRef: true });
    expect(upRef.normalize(`${BASE}/p?ref=partner`)).toBe(`${BASE}/p`);
  });

  it("CN-04: a canonical with tracking params is self vs the cleaned page URL", () => {
    expect(
      isSelfCanonical(`${BASE}/p?utm_source=x`, `${BASE}/p`),
    ).toBe(true);
  });

  it("CN-04: param order doesn't cause a self-canonical mismatch", () => {
    expect(isSelfCanonical(`${BASE}/p?b=2&a=1`, `${BASE}/p?a=1&b=2`)).toBe(true);
  });
});

describe("classifyPageType", () => {
  it("treats ordinary content paths as content", () => {
    expect(classifyPageType(`${BASE}/`)).toBe("content");
    expect(classifyPageType(`${BASE}/services/bookkeeping`)).toBe("content");
    expect(classifyPageType(`${BASE}/about-us`)).toBe("content");
    expect(classifyPageType(`${BASE}/blog/how-to-choose-a-bookkeeper`)).toBe(
      "content",
    );
  });

  it("detects WordPress taxonomy pages", () => {
    expect(classifyPageType(`${BASE}/tag/ceo-mindset`)).toBe("tag");
    expect(classifyPageType(`${BASE}/tags/payroll/`)).toBe("tag");
    expect(classifyPageType(`${BASE}/category/news`)).toBe("category");
    expect(classifyPageType(`${BASE}/categories/news`)).toBe("category");
    expect(classifyPageType(`${BASE}/author/jane`)).toBe("author");
  });

  it("detects pagination anywhere in the path, ahead of the archive type", () => {
    expect(classifyPageType(`${BASE}/blog/page/2`)).toBe("pagination");
    expect(classifyPageType(`${BASE}/page/4/`)).toBe("pagination");
    // A paginated tag archive is classified as pagination (still excluded).
    expect(classifyPageType(`${BASE}/tag/payroll/page/3/`)).toBe("pagination");
  });

  it("detects date archives, feeds, search, and attachments", () => {
    expect(classifyPageType(`${BASE}/2024`)).toBe("date_archive");
    expect(classifyPageType(`${BASE}/2024/08/`)).toBe("date_archive");
    expect(classifyPageType(`${BASE}/2024/08/24`)).toBe("date_archive");
    expect(classifyPageType(`${BASE}/feed/`)).toBe("feed");
    expect(classifyPageType(`${BASE}/search/bookkeeping`)).toBe("search");
    expect(classifyPageType(`${BASE}/?s=payroll`)).toBe("search");
    expect(classifyPageType(`${BASE}/?attachment_id=1234`)).toBe("attachment");
  });

  it("treats auth/cart utility pages as utility", () => {
    expect(classifyPageType(`${BASE}/cart`)).toBe("utility");
    expect(classifyPageType(`${BASE}/my-account/`)).toBe("utility");
  });

  it("isContentPage is true only for content", () => {
    expect(isContentPage(`${BASE}/services`)).toBe(true);
    expect(isContentPage(`${BASE}/tag/x`)).toBe(false);
    expect(isContentPage(`${BASE}/blog/page/2`)).toBe(false);
  });

  it("a date-like segment inside a longer content path is not a date archive", () => {
    expect(classifyPageType(`${BASE}/2024/best-bookkeeping-tips`)).toBe(
      "content",
    );
  });
});

describe("UrlProcessor.normalize param folding", () => {
  const up = new UrlProcessor(BASE);

  it("folds Divi's empty ?et_blog= to the clean URL (no phantom duplicate)", () => {
    expect(up.normalize(`${BASE}/blogs/page/2?et_blog=`)).toBe(
      `${BASE}/blogs/page/2`,
    );
  });

  it("strips utm and other empty-valued params", () => {
    expect(up.normalize(`${BASE}/services?utm_source=fb&ref=`)).toBe(
      `${BASE}/services`,
    );
  });

  it("keeps a meaningful, valued param", () => {
    expect(up.normalize(`${BASE}/search?id=5`)).toBe(`${BASE}/search?id=5`);
  });

  it("U-02: sorts params so order variants canonicalise to one URL", () => {
    expect(up.normalize(`${BASE}/p?b=2&a=1`)).toBe(`${BASE}/p?a=1&b=2`);
    expect(up.normalize(`${BASE}/p?size=l&color=red`)).toBe(
      up.normalize(`${BASE}/p?color=red&size=l`),
    );
  });
});

describe("UrlProcessor.normalize scheme handling (U-01)", () => {
  it("upgrades http→https for the project's own host when the project is https", () => {
    const up = new UrlProcessor("https://blubookkeepers.com");
    expect(up.normalize("http://blubookkeepers.com/about")).toBe(
      "https://blubookkeepers.com/about",
    );
  });

  it("preserves http for an external host (no blind upgrade)", () => {
    const up = new UrlProcessor("https://blubookkeepers.com");
    expect(up.normalize("http://partner.example/page")).toBe(
      "http://partner.example/page",
    );
  });

  it("does NOT force https on a genuinely http-only project", () => {
    const up = new UrlProcessor("http://legacy-intranet.example");
    expect(up.normalize("http://legacy-intranet.example/home")).toBe(
      "http://legacy-intranet.example/home",
    );
  });
});

describe("UrlProcessor.shouldExclude — calendar feeds & event views", () => {
  const up = new UrlProcessor(BASE);

  it("excludes iCal feed exports in both modes", () => {
    for (const mode of ["seo", "audit"] as const) {
      expect(up.shouldExclude(`${BASE}/events/2026-09-19?ical=1`, [], mode)).toBe(true);
      expect(up.shouldExclude(`${BASE}/events/month/2026-10?outlook-ical=1`, [], mode)).toBe(true);
    }
  });

  it("excludes The Events Calendar date/view filters", () => {
    expect(up.shouldExclude(`${BASE}/events/list?tribe-bar-date=2026-08-01`)).toBe(true);
    expect(up.shouldExclude(`${BASE}/events/list?eventDisplay=past`)).toBe(true);
  });

  it("still crawls the main events page and real event day pages", () => {
    expect(up.shouldExclude(`${BASE}/events`)).toBe(false);
    expect(up.shouldExclude(`${BASE}/events/2026-09-19`)).toBe(false);
  });

  it("does not exclude an ordinary content page", () => {
    expect(up.shouldExclude(`${BASE}/about`)).toBe(false);
  });
});
