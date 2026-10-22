// Typed-client shim for the v1 tables.
//
// The v1 tables (api_keys, api_jobs, api_key_usage) and the
// increment_api_key_usage RPC are created by
// migrations/2026-10-22_0001_v1_jobs_api.sql, which is NOT yet applied, so they
// are absent from the generated src/database.types.ts and the strongly-typed
// Supabase client refuses to reference them. This returns the SAME runtime
// service-role client, typed permissively for exactly those tables.
//
// After the migration is applied and database.types.ts is regenerated, the v1
// stores can use the normal typed client and this shim can be deleted.

import { getSupabaseServiceClient } from "../../database/client";

export interface V1Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

export function v1Db(): V1Db {
  return getSupabaseServiceClient() as unknown as V1Db;
}
