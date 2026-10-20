/**
 * robots.txt parsing + matching (RB-01/RB-02/RB-03/RB-07).
 *
 * Pure and deterministic so it is fully unit-testable. Implements the parts of
 * the Robots Exclusion Protocol that matter for a well-behaved, identifiable
 * crawler:
 *   - group selection by the MOST SPECIFIC matching user-agent (a specific
 *     group fully overrides the `*` group — RB-03),
 *   - Allow/Disallow with `*` wildcards and `$` end-anchors, longest-match wins,
 *     Allow breaking ties (RB-07),
 *   - Crawl-delay (RB-02),
 *   - Sitemap discovery.
 *
 * Reference: Google's robots.txt spec (longest-match, Allow-wins-on-tie).
 */

export type RobotsRuleType = "allow" | "disallow";

export interface RobotsRule {
  type: RobotsRuleType;
  /** The raw path pattern as written (may contain `*` and a trailing `$`). */
  path: string;
}

export interface RobotsGroup {
  /** Lower-cased user-agent tokens this group applies to. */
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** Parse robots.txt text into groups + sitemaps. */
export function parseRobots(content: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  // True while we're still collecting consecutive `User-agent:` lines for one
  // group (before any rule line). A rule line "closes" the agent list so the
  // next `User-agent:` starts a fresh group.
  let collectingAgents = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    switch (field) {
      case "user-agent": {
        if (!value) break;
        if (!current || !collectingAgents) {
          current = { agents: [], rules: [] };
          groups.push(current);
          collectingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;
      }
      case "allow":
      case "disallow": {
        if (!current) break;
        collectingAgents = false;
        // A blank Disallow means "allow everything" — represented by no rule.
        // A blank Allow is meaningless; skip it.
        if (value === "") break;
        current.rules.push({ type: field, path: value });
        break;
      }
      case "crawl-delay": {
        if (!current) break;
        collectingAgents = false;
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
        break;
      }
      case "sitemap": {
        if (value) sitemaps.push(value);
        break;
      }
      default:
        // Unknown field — ignore, but it ends the agent-collection phase.
        if (current) collectingAgents = false;
    }
  }

  return { groups, sitemaps };
}

/**
 * Select the single applicable group for our crawler (RB-03): the group whose
 * user-agent token is the longest case-insensitive prefix of one of our product
 * tokens. `*` matches only as a fallback. Returns null when nothing matches.
 */
function selectGroup(
  robots: RobotsTxt,
  productTokens: string[],
): RobotsGroup | null {
  const ours = productTokens.map((t) => t.toLowerCase());
  let best: { group: RobotsGroup; score: number } | null = null;
  let star: RobotsGroup | null = null;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === "*") {
        // Keep the first `*` group as the fallback.
        if (!star) star = group;
        continue;
      }
      // A robots agent token matches when it is a prefix of our product token
      // (e.g. "rankriot" matches "rankriotbot"), case-insensitive.
      if (ours.some((t) => t.startsWith(agent))) {
        const score = agent.length;
        if (!best || score > best.score) best = { group, score };
      }
    }
  }

  if (best) return best.group;
  return star;
}

/** Translate a robots path pattern (`*`, trailing `$`) to a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  let p = pattern;
  let anchorEnd = false;
  if (p.endsWith("$")) {
    anchorEnd = true;
    p = p.slice(0, -1);
  }
  // Escape regex specials except `*`, which becomes `.*`.
  const body = p
    .split("*")
    .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchorEnd ? "$" : ""));
}

/** The portion of a URL robots matches against: path + query. */
export function robotsPathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + (u.search || "");
  } catch {
    return url.startsWith("/") ? url : "/" + url;
  }
}

/**
 * Is `url` allowed for our crawler under these rules?
 * Longest-matching rule wins; Allow wins ties; no match = allowed (RB-07).
 */
export function isPathAllowed(
  robots: RobotsTxt,
  url: string,
  productTokens: string[],
): boolean {
  const group = selectGroup(robots, productTokens);
  if (!group || group.rules.length === 0) return true;

  const path = robotsPathOf(url);
  let best: { rule: RobotsRule; length: number } | null = null;

  for (const rule of group.rules) {
    if (patternToRegExp(rule.path).test(path)) {
      const length = rule.path.length;
      if (
        !best ||
        length > best.length ||
        // Tie: Allow wins over Disallow.
        (length === best.length && rule.type === "allow" && best.rule.type === "disallow")
      ) {
        best = { rule, length };
      }
    }
  }

  if (!best) return true;
  return best.rule.type === "allow";
}

/** Crawl-delay (seconds) that applies to our crawler, if any (RB-02). */
export function getCrawlDelay(
  robots: RobotsTxt,
  productTokens: string[],
): number | undefined {
  return selectGroup(robots, productTokens)?.crawlDelay;
}
