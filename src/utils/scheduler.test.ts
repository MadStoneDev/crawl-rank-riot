import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture the bulk-update the recovery runs, and let each test set the rows the
// fake DB "updates". The scheduler only calls getSupabaseServiceClient() here.
const mock = vi.hoisted(() => ({
  result: { data: [] as Array<{ id: string }> | null, error: null as unknown },
  captured: {
    table: "",
    payload: null as Record<string, unknown> | null,
    eqCol: "",
    eqVal: "",
    selected: "",
  },
}));

vi.mock("../services/database/client", () => ({
  getSupabaseServiceClient: () => ({
    from: (table: string) => {
      mock.captured.table = table;
      return {
        update: (payload: Record<string, unknown>) => {
          mock.captured.payload = payload;
          return {
            eq: (col: string, val: string) => {
              mock.captured.eqCol = col;
              mock.captured.eqVal = val;
              return {
                select: (cols: string) => {
                  mock.captured.selected = cols;
                  return Promise.resolve(mock.result);
                },
              };
            },
          };
        },
      };
    },
  }),
}));

import { CrawlScheduler, INTERRUPTED_BY_RESTART_REASON } from "./scheduler";

describe("CrawlScheduler.recoverInterruptedScans", () => {
  beforeEach(() => {
    mock.result = { data: [], error: null };
    mock.captured = { table: "", payload: null, eqCol: "", eqVal: "", selected: "" };
  });

  it("fails every in_progress scan with the restart reason and returns the count", async () => {
    mock.result = { data: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], error: null };

    const count = await new CrawlScheduler().recoverInterruptedScans();

    expect(count).toBe(3);
    // Targets exactly the stuck scans.
    expect(mock.captured.table).toBe("scans");
    expect(mock.captured.eqCol).toBe("status");
    expect(mock.captured.eqVal).toBe("in_progress");
    // Marks them failed with the canonical reason in both places the app reads.
    expect(mock.captured.payload?.status).toBe("failed");
    expect(mock.captured.payload?.failure_reason).toBe(INTERRUPTED_BY_RESTART_REASON);
    expect(mock.captured.payload?.failure_reason).toBe("Interrupted by a server restart");
    expect((mock.captured.payload?.summary_stats as { error_message: string }).error_message).toBe(
      INTERRUPTED_BY_RESTART_REASON,
    );
    expect(typeof mock.captured.payload?.completed_at).toBe("string");
  });

  it("returns 0 and changes nothing when no scan is in_progress", async () => {
    mock.result = { data: [], error: null };
    const count = await new CrawlScheduler().recoverInterruptedScans();
    expect(count).toBe(0);
  });

  it("stamps a caller-supplied reason (used by graceful shutdown)", async () => {
    mock.result = { data: [{ id: "s1" }], error: null };
    await new CrawlScheduler().recoverInterruptedScans("Interrupted by shutdown");
    expect(mock.captured.payload?.failure_reason).toBe("Interrupted by shutdown");
  });

  it("never throws on a DB error — returns 0 so the server can still boot", async () => {
    mock.result = { data: null, error: { message: "connection refused" } };
    const count = await new CrawlScheduler().recoverInterruptedScans();
    expect(count).toBe(0);
  });
});
