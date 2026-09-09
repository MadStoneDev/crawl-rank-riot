import { describe, it, expect } from "vitest";
import { classifyPageType, isContentPage, UrlProcessor } from "./url";

const BASE = "https://blubookkeepers.com";

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
});
