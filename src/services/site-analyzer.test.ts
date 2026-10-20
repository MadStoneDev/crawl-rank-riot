import { describe, it, expect } from "vitest";
import { classifyAiBots } from "./site-analyzer";
import { parseRobots } from "../utils/robots";

const ORIGIN = "https://example.com";

function classify(robotsTxt: string) {
  const result = { ai_bots_blocked: [] as string[], ai_bots_allowed: [] as string[] };
  classifyAiBots(parseRobots(robotsTxt), ORIGIN, result);
  return result;
}

describe("classifyAiBots (RB-03)", () => {
  it("does NOT report a bot as blocked when its own group overrides a blanket * block", () => {
    // The false positive: `*` disallows everything, but GPTBot has its own
    // permissive group — robots.txt group selection means GPTBot is NOT blocked.
    const { ai_bots_blocked, ai_bots_allowed } = classify(
      ["User-agent: *", "Disallow: /", "", "User-agent: GPTBot", "Disallow:"].join("\n"),
    );
    expect(ai_bots_blocked).not.toContain("GPTBot");
    expect(ai_bots_allowed).toContain("GPTBot");
    // A bot with no group of its own still falls under `*` and is blocked.
    expect(ai_bots_blocked).toContain("CCBot");
  });

  it("honours an Allow:/ override inside the bot's own Disallow:/ group", () => {
    const { ai_bots_blocked } = classify(
      ["User-agent: GPTBot", "Disallow: /", "Allow: /"].join("\n"),
    );
    expect(ai_bots_blocked).not.toContain("GPTBot");
  });

  it("reports a bot blocked only in its own path, not site-wide, as allowed", () => {
    const { ai_bots_blocked, ai_bots_allowed } = classify(
      ["User-agent: GPTBot", "Disallow: /private"].join("\n"),
    );
    expect(ai_bots_blocked).not.toContain("GPTBot");
    expect(ai_bots_allowed).toContain("GPTBot");
  });

  it("reports a genuinely site-wide-blocked bot", () => {
    const { ai_bots_blocked } = classify(
      ["User-agent: GPTBot", "Disallow: /"].join("\n"),
    );
    expect(ai_bots_blocked).toContain("GPTBot");
  });

  it("blocks every AI bot under a blanket * Disallow: / with no overrides", () => {
    const { ai_bots_blocked, ai_bots_allowed } = classify(
      ["User-agent: *", "Disallow: /"].join("\n"),
    );
    expect(ai_bots_blocked).toContain("GPTBot");
    expect(ai_bots_blocked).toContain("ClaudeBot");
    // None are "explicitly allowed" since none have their own group.
    expect(ai_bots_allowed).toEqual([]);
  });

  it("leaves an unaddressed bot neither blocked nor explicitly allowed", () => {
    const { ai_bots_blocked, ai_bots_allowed } = classify(
      ["User-agent: Googlebot", "Disallow: /admin"].join("\n"),
    );
    // GPTBot isn't addressed and `*` isn't blocking → not blocked, not in the
    // explicit-allow list either.
    expect(ai_bots_blocked).not.toContain("GPTBot");
    expect(ai_bots_allowed).not.toContain("GPTBot");
  });
});
