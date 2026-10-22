import { describe, it, expect } from "vitest";
import {
  recordUsage,
  getCurrentUsage,
  utcDay,
  monthStart,
  nextMonthStart,
  type UsageStore,
  type MonthUsage,
} from "./usage";

function fakeStore(month: MonthUsage = { requests: 0, jobs_created: 0 }) {
  const calls: Array<{ day: string; requests: number; jobs: number }> = [];
  const store: UsageStore & { calls: typeof calls } = {
    calls,
    async increment(_id, day, requests, jobs) {
      calls.push({ day, requests, jobs });
    },
    async monthTotals() {
      return month;
    },
  };
  return store;
}

describe("period helpers (UTC)", () => {
  it("computes day, month start and next-month start", () => {
    const d = new Date("2026-10-22T13:45:00Z");
    expect(utcDay(d)).toBe("2026-10-22");
    expect(monthStart(d)).toBe("2026-10-01");
    expect(nextMonthStart(d)).toBe("2026-11-01");
  });

  it("rolls the year over in December", () => {
    const d = new Date("2026-12-15T00:00:00Z");
    expect(nextMonthStart(d)).toBe("2027-01-01");
  });
});

describe("recordUsage", () => {
  it("increments the current UTC day with the given deltas", async () => {
    const store = fakeStore();
    await recordUsage("key_1", { requests: 1, jobs: 1 }, store, new Date("2026-10-22T00:00:00Z"));
    expect(store.calls).toEqual([{ day: "2026-10-22", requests: 1, jobs: 1 }]);
  });

  it("defaults missing deltas to zero", async () => {
    const store = fakeStore();
    await recordUsage("key_1", { requests: 1 }, store, new Date("2026-10-22T00:00:00Z"));
    expect(store.calls[0]).toEqual({ day: "2026-10-22", requests: 1, jobs: 0 });
  });

  it("never throws when the store fails", async () => {
    const throwing: UsageStore = {
      async increment() {
        throw new Error("db down");
      },
      async monthTotals() {
        return { requests: 0, jobs_created: 0 };
      },
    };
    await expect(recordUsage("key_1", { requests: 1 }, throwing)).resolves.toBeUndefined();
  });
});

describe("getCurrentUsage", () => {
  it("returns the month totals and period start", async () => {
    const store = fakeStore({ requests: 120, jobs_created: 8 });
    const res = await getCurrentUsage("key_1", store, new Date("2026-10-22T00:00:00Z"));
    expect(res.periodStart).toBe("2026-10-01");
    expect(res.usage).toEqual({ requests: 120, jobs_created: 8 });
  });

  it("falls back to zero usage when the store throws", async () => {
    const throwing: UsageStore = {
      async increment() {},
      async monthTotals() {
        throw new Error("db down");
      },
    };
    const res = await getCurrentUsage("key_1", throwing, new Date("2026-10-22T00:00:00Z"));
    expect(res.usage).toEqual({ requests: 0, jobs_created: 0 });
  });
});
