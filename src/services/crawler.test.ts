import { describe, it, expect } from "vitest";
import { effectiveConcurrency, describePartialCrawl } from "./crawler";

describe("effectiveConcurrency (PL-02)", () => {
  it("serialises (cap 1) when the host declares a Crawl-delay", () => {
    expect(effectiveConcurrency(3, 1000)).toBe(1);
    expect(effectiveConcurrency(10, 10_000)).toBe(1);
  });

  it("uses the configured concurrency when there is no Crawl-delay", () => {
    expect(effectiveConcurrency(3, 0)).toBe(3);
    expect(effectiveConcurrency(10, 0)).toBe(10);
  });

  it("never drops below 1", () => {
    expect(effectiveConcurrency(0, 0)).toBe(1);
  });
});

describe("describePartialCrawl (PL-03)", () => {
  it("marks a completed crawl as not partial", () => {
    expect(
      describePartialCrawl({
        crawlCompleted: true,
        crawlStopReason: "complete",
        queueRemainingAtStop: 0,
        pagesCrawled: 120,
      }),
    ).toEqual({ partial: false, reason: "complete", pages_crawled: 120, queue_remaining: 0 });
  });

  it("marks a timed-out crawl partial with the remaining queue", () => {
    const s = describePartialCrawl({
      crawlCompleted: false,
      crawlStopReason: "timeout",
      queueRemainingAtStop: 480,
      pagesCrawled: 3,
    });
    expect(s.partial).toBe(true);
    expect(s.reason).toBe("timeout");
    expect(s.queue_remaining).toBe(480);
  });

  it("marks a page-capped crawl partial", () => {
    expect(
      describePartialCrawl({
        crawlCompleted: false,
        crawlStopReason: "max_pages",
        queueRemainingAtStop: 1200,
        pagesCrawled: 500,
      }).partial,
    ).toBe(true);
  });
});
