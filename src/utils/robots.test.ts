import { describe, it, expect } from "vitest";
import { parseRobots, isPathAllowed, getCrawlDelay } from "./robots";

const UA = ["RankRiotBot"];
const allowed = (txt: string, url: string, ua = UA) =>
  isPathAllowed(parseRobots(txt), url, ua);

describe("parseRobots", () => {
  it("collects sitemaps globally", () => {
    const r = parseRobots(`Sitemap: https://x.com/s.xml\nUser-agent: *\nDisallow:`);
    expect(r.sitemaps).toEqual(["https://x.com/s.xml"]);
  });
  it("ignores comments and blank lines", () => {
    const r = parseRobots(`# hi\nUser-agent: *\n  \nDisallow: /a # inline`);
    expect(r.groups[0].rules).toEqual([{ type: "disallow", path: "/a" }]);
  });
});

describe("RB-01: Disallow is obeyed", () => {
  it("blocks a disallowed path for *", () => {
    const txt = `User-agent: *\nDisallow: /staging/`;
    expect(allowed(txt, "https://x.com/staging/page")).toBe(false);
    expect(allowed(txt, "https://x.com/public")).toBe(true);
  });
  it("blank Disallow means allow all", () => {
    expect(allowed(`User-agent: *\nDisallow:`, "https://x.com/anything")).toBe(true);
  });
  it("no robots rules at all means allowed", () => {
    expect(allowed(``, "https://x.com/anything")).toBe(true);
  });
});

describe("RB-03: specific group overrides the * group", () => {
  const txt = `User-agent: *\nDisallow: /\n\nUser-agent: RankRiotBot\nAllow: /`;
  it("our bot follows its own group, not *", () => {
    expect(allowed(txt, "https://x.com/anything")).toBe(true);
  });
  it("an unrelated bot still follows *", () => {
    expect(isPathAllowed(parseRobots(txt), "https://x.com/anything", ["SomeOtherBot"])).toBe(false);
  });
  it("matches our token by prefix (RankRiot -> RankRiotBot)", () => {
    const t = `User-agent: *\nDisallow: /\n\nUser-agent: RankRiot\nAllow: /`;
    expect(allowed(t, "https://x.com/x")).toBe(true);
  });
});

describe("RB-07: longest-match, Allow wins ties, wildcards + $", () => {
  it("Allow of a sub-path overrides a broader Disallow (longest match)", () => {
    const txt = `User-agent: *\nDisallow: /admin/\nAllow: /admin/public/`;
    expect(allowed(txt, "https://x.com/admin/secret")).toBe(false);
    expect(allowed(txt, "https://x.com/admin/public/page")).toBe(true);
  });
  it("Allow wins when patterns tie in length", () => {
    const txt = `User-agent: *\nDisallow: /a\nAllow: /a`;
    expect(allowed(txt, "https://x.com/a")).toBe(true);
  });
  it("* wildcard matches query URLs", () => {
    const txt = `User-agent: *\nDisallow: /*?`;
    expect(allowed(txt, "https://x.com/p?q=1")).toBe(false);
    expect(allowed(txt, "https://x.com/p")).toBe(true);
  });
  it("$ anchors the end of the path", () => {
    const txt = `User-agent: *\nDisallow: /private$`;
    expect(allowed(txt, "https://x.com/private")).toBe(false);
    expect(allowed(txt, "https://x.com/private/child")).toBe(true);
  });
  it("*.pdf style patterns", () => {
    const txt = `User-agent: *\nDisallow: /*.pdf$`;
    expect(allowed(txt, "https://x.com/docs/file.pdf")).toBe(false);
    expect(allowed(txt, "https://x.com/docs/file.html")).toBe(true);
  });
});

describe("RB-02: Crawl-delay", () => {
  it("reads the delay for our group", () => {
    const r = parseRobots(`User-agent: *\nCrawl-delay: 10\nDisallow:`);
    expect(getCrawlDelay(r, UA)).toBe(10);
  });
  it("prefers our specific group's delay over *", () => {
    const r = parseRobots(`User-agent: *\nCrawl-delay: 30\n\nUser-agent: RankRiotBot\nCrawl-delay: 5`);
    expect(getCrawlDelay(r, UA)).toBe(5);
  });
  it("undefined when none set", () => {
    expect(getCrawlDelay(parseRobots(`User-agent: *\nDisallow:`), UA)).toBeUndefined();
  });
});
