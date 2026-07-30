import { describe, it, expect } from "vitest";
import { BrowserPool } from "./browser";

// Bypass the real puppeteer launch by injecting a fake connected browser, so we
// can exercise the concurrency gate without Chrome.
function poolWithFakeBrowser(maxPages: number): BrowserPool {
  const pool = new BrowserPool(maxPages);
  (pool as any).browser = { connected: true };
  return pool;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("BrowserPool concurrency cap", () => {
  it("allows up to maxPages concurrent acquisitions", async () => {
    const pool = poolWithFakeBrowser(2);
    await pool.acquire();
    await pool.acquire();
    expect((pool as any).pageCount).toBe(2);
  });

  it("blocks the (maxPages+1)th acquire until a slot is released", async () => {
    const pool = poolWithFakeBrowser(2);
    await pool.acquire();
    await pool.acquire();

    let thirdResolved = false;
    const third = pool.acquire().then(() => {
      thirdResolved = true;
    });

    await tick();
    expect(thirdResolved).toBe(false); // gated
    expect((pool as any).pageCount).toBe(2); // never overshoots

    pool.release(); // frees a slot -> wakes the waiter
    await third;
    expect(thirdResolved).toBe(true);
    expect((pool as any).pageCount).toBe(2);
  });

  it("never exceeds the cap under a burst of concurrent acquires", async () => {
    const pool = poolWithFakeBrowser(3);
    let observedMax = 0;
    const record = () => {
      observedMax = Math.max(observedMax, (pool as any).pageCount);
    };

    // Fire 10 acquire→release cycles at once.
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        await pool.acquire();
        record();
        await tick();
        pool.release();
      }),
    );

    expect(observedMax).toBeLessThanOrEqual(3);
    expect((pool as any).pageCount).toBe(0);
  });
});
