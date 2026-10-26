import { describe, it, expect } from "vitest";
import { detectBotBlock } from "./bot-block";

describe("detectBotBlock", () => {
  it("returns null when nothing was blocked", () => {
    expect(
      detectBotBlock({ pagesScanned: 10, blockedCount: 0, homepageBlocked: false }),
    ).toBeNull();
  });

  it("flags a fully-blocked crawl (homepage blocked, zero pages read) (PC-09)", () => {
    const info = detectBotBlock({
      pagesScanned: 0,
      blockedCount: 1,
      homepageBlocked: true,
      sampleError:
        "Blocked by bot protection / WAF challenge page (blocked IP 203.0.113.9)",
    });
    expect(info).not.toBeNull();
    expect(info!.blocked).toBe(true);
    expect(info!.blocked_pages).toBe(1);
    expect(info!.total_pages).toBe(1);
    // Prefers the IP embedded in the challenge over the configured egress IP.
    expect(info!.egress_ip).toBe("203.0.113.9");
    expect(typeof info!.user_agent).toBe("string");
  });

  it("flags a mostly-blocked crawl even if the homepage got through", () => {
    const info = detectBotBlock({
      pagesScanned: 1,
      blockedCount: 3,
      homepageBlocked: false,
    });
    expect(info).not.toBeNull();
    expect(info!.total_pages).toBe(4);
  });

  it("does not flag a crawl with only a few blocked pages and a reachable homepage", () => {
    expect(
      detectBotBlock({ pagesScanned: 90, blockedCount: 10, homepageBlocked: false }),
    ).toBeNull();
  });
});
