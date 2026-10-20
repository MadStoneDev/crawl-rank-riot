import { describe, it, expect } from "vitest";
import { looksLikeNotFound, isSoft404 } from "./soft404";

describe("looksLikeNotFound (S-01)", () => {
  it("matches common not-found titles/H1s", () => {
    expect(looksLikeNotFound(["Page Not Found"])).toBe(true);
    expect(looksLikeNotFound(["404 - Page Not Found | Acme"])).toBe(true);
    expect(looksLikeNotFound(["Oops! The page you requested doesn't exist"])).toBe(true);
    expect(looksLikeNotFound([undefined, "Sorry, this page cannot be found"])).toBe(true);
    expect(looksLikeNotFound(["This product is no longer available"])).toBe(true);
  });
  it("does NOT match legitimate content that merely mentions 404", () => {
    expect(looksLikeNotFound(["Understanding 404 Errors in Web Development"])).toBe(false);
    expect(looksLikeNotFound(["How we found our new office"])).toBe(false);
    expect(looksLikeNotFound(["About Our Team"])).toBe(false);
  });
  it("ignores empty input", () => {
    expect(looksLikeNotFound([])).toBe(false);
    expect(looksLikeNotFound([undefined, "", "   "])).toBe(false);
  });
});

describe("isSoft404 (S-01)", () => {
  it("flags a 200 'not found' page", () => {
    expect(isSoft404(200, "Page Not Found", [])).toBe(true);
  });
  it("does not flag a real 404 (status already tells the story)", () => {
    expect(isSoft404(404, "Page Not Found", [])).toBe(false);
  });
  it("does not flag a healthy 200 page", () => {
    expect(isSoft404(200, "Premium Hiking Boots", ["Premium Hiking Boots"])).toBe(false);
  });
  it("uses H1 when the title is generic", () => {
    expect(isSoft404(200, "Acme Store", ["Sorry, that page doesn't exist"])).toBe(true);
  });
});
