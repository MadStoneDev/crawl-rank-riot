-- Stage 3 hardening (defense-in-depth) for the /api/v1 jobs API tables.
--
-- NOT YET APPLIED. Optional: 2026-10-22_0001 already passes the security bar
-- (RLS enabled on all three tables, no policies, no key material in any view
-- or function). This file closes a lesser gap and can be applied at leisure.
--
-- Why: Supabase's defaults GRANT table privileges and PUBLIC EXECUTE on new
-- public objects, so the anon/authenticated roles can still *attempt* to reach
-- api_keys / api_jobs / api_key_usage and call increment_api_key_usage via
-- PostgREST. RLS (enabled, no policies) already denies every row and the RPC is
-- SECURITY INVOKER so its write is denied too — no data leaks and nothing can
-- be written. These REVOKEs simply stop the objects being exposed at all,
-- shrinking the attack surface and keeping them out of the public API schema.
--
-- Safe for the frontend: the app never touches the api_* tables or this RPC;
-- all v1 access is through the crawler's service-role client, which bypasses
-- both GRANTs and RLS.

revoke all on table public.api_keys      from anon, authenticated;
revoke all on table public.api_jobs      from anon, authenticated;
revoke all on table public.api_key_usage from anon, authenticated;

revoke all on function public.increment_api_key_usage(uuid, date, integer, integer)
  from public, anon, authenticated;
