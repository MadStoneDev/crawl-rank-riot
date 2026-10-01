import { describe, it, expect } from "vitest";
import {
  classifyLinkStatus,
  isBlockedStatus,
  shouldRetryWithBrowserUa,
} from "./link-status";

describe("classifyLinkStatus (P0.4)", () => {
  it("treats bot-block / rate-limit codes as blocked, not broken", () => {
    // The DIRT fixture's 7 "broken" links: Reddit 403, ActiveCampaign 403,
    // LinkedIn 999.
    expect(classifyLinkStatus(403)).toBe("blocked");
    expect(classifyLinkStatus(999)).toBe("blocked");
    expect(classifyLinkStatus(401)).toBe("blocked");
    expect(classifyLinkStatus(429)).toBe("blocked");
    expect(classifyLinkStatus(503)).toBe("blocked");
  });

  it("treats genuinely dead links as broken", () => {
    expect(classifyLinkStatus(404)).toBe("broken");
    expect(classifyLinkStatus(410)).toBe("broken");
    expect(classifyLinkStatus(500)).toBe("broken");
    expect(classifyLinkStatus(502)).toBe("broken");
  });

  it("treats unreachable (null/0) as broken", () => {
    expect(classifyLinkStatus(null)).toBe("broken");
    expect(classifyLinkStatus(undefined)).toBe("broken");
    expect(classifyLinkStatus(0)).toBe("broken");
  });

  it("classifies 2xx/3xx", () => {
    expect(classifyLinkStatus(200)).toBe("ok");
    expect(classifyLinkStatus(204)).toBe("ok");
    expect(classifyLinkStatus(301)).toBe("redirect");
    expect(classifyLinkStatus(308)).toBe("redirect");
  });

  it("isBlockedStatus and shouldRetryWithBrowserUa agree with the policy", () => {
    expect(isBlockedStatus(403)).toBe(true);
    expect(isBlockedStatus(404)).toBe(false);
    expect(shouldRetryWithBrowserUa(403)).toBe(true);
    expect(shouldRetryWithBrowserUa(999)).toBe(true);
    expect(shouldRetryWithBrowserUa(503)).toBe(false); // 503 isn't UA-related
    expect(shouldRetryWithBrowserUa(404)).toBe(false);
  });
});
