// Typed-client shim for the Stage 4 tables/columns.
//
// api_projects, api_job_pages and the new api_jobs columns (external_ref,
// metadata, scope, modules, result) are created by
// migrations/2026-10-24_0001_v1_stage4.sql, which is NOT yet applied, so they
// are absent from the generated database.types.ts and the strongly-typed
// Supabase client refuses to reference them. This returns the SAME runtime
// service-role client, typed permissively for exactly those tables.
//
// After the migration is applied and database.types.ts is regenerated, switch
// these call sites to the normal typed client and delete this shim (same
// lifecycle as the Stage 3 db.ts shim).

import { getSupabaseServiceClient } from "../../database/client";

export interface Stage4Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export function stage4Db(): Stage4Db {
  return getSupabaseServiceClient() as unknown as Stage4Db;
}
