// Per-key usage metering for the /api/v1 jobs API (Stage 3).
//
// Counters are kept per key, per UTC day (api_key_usage); monthly usage is the
// sum of the month's rows. Writes go through an atomic SQL increment so
// concurrent requests don't clobber each other. The DB-coupled part is behind a
// UsageStore port so the month math is unit-testable without a DB. All metering
// is best-effort: a metering failure must never fail the API request.

import { getSupabaseServiceClient } from "../../database/client";

export interface MonthUsage {
  requests: number;
  jobs_created: number;
}

export interface UsageStore {
  increment(apiKeyId: string, day: string, requests: number, jobs: number): Promise<void>;
  monthTotals(apiKeyId: string, monthStartInclusive: string, nextMonthExclusive: string): Promise<MonthUsage>;
}

/** YYYY-MM-DD for a date in UTC. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the month (YYYY-MM-01) for a date in UTC. */
export function monthStart(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 7)}-01`;
}

/** First day of the FOLLOWING month (exclusive upper bound), UTC. */
export function nextMonthStart(d: Date = new Date()): string {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

/** Record usage for a key (best-effort; swallows errors). */
export async function recordUsage(
  apiKeyId: string,
  delta: { requests?: number; jobs?: number },
  store: UsageStore = supabaseUsageStore(),
  now: Date = new Date(),
): Promise<void> {
  try {
    await store.increment(apiKeyId, utcDay(now), delta.requests ?? 0, delta.jobs ?? 0);
  } catch {
    // Metering is never allowed to break the request.
  }
}

/** Current calendar-month usage for a key. */
export async function getCurrentUsage(
  apiKeyId: string,
  store: UsageStore = supabaseUsageStore(),
  now: Date = new Date(),
): Promise<{ periodStart: string; usage: MonthUsage }> {
  const periodStart = monthStart(now);
  try {
    const usage = await store.monthTotals(apiKeyId, periodStart, nextMonthStart(now));
    return { periodStart, usage };
  } catch {
    return { periodStart, usage: { requests: 0, jobs_created: 0 } };
  }
}

/** Default store backed by the Supabase service-role client. */
export function supabaseUsageStore(): UsageStore {
  return {
    async increment(apiKeyId, day, requests, jobs): Promise<void> {
      await getSupabaseServiceClient().rpc("increment_api_key_usage", {
        p_api_key_id: apiKeyId,
        p_day: day,
        p_requests: requests,
        p_jobs: jobs,
      });
    },
    async monthTotals(apiKeyId, monthStartInclusive, nextMonthExclusive): Promise<MonthUsage> {
      const { data } = await getSupabaseServiceClient()
        .from("api_key_usage")
        .select("requests, jobs_created")
        .eq("api_key_id", apiKeyId)
        .gte("day", monthStartInclusive)
        .lt("day", nextMonthExclusive);
      let requests = 0;
      let jobs_created = 0;
      for (const row of (data ?? []) as Array<{ requests?: number; jobs_created?: number }>) {
        requests += row.requests ?? 0;
        jobs_created += row.jobs_created ?? 0;
      }
      return { requests, jobs_created };
    },
  };
}
