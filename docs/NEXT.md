# NEXT — crawl-rank-riot

Start-here for a fresh session. Read alongside `CLAUDE.md`. Last updated 2026-10-28.

## Current state

`main` is the live branch. Recent work (all committed on `main`):

- **F-D12** (`a0fb6fd`, pushed): two new persisted technical issues — `deep_page`
  (indexable content page ≥ 4 clicks from home) and `weak_internal_linking`
  (indexable content page with 1–2 inbound internal links; mutually exclusive
  with `orphan_page`). Both low severity, category `technical`, `is_speed` false.
  `/api/v1` `SCHEMA_VERSION` bumped to **1.3.0** (additive), `docs/api/v1.md`
  updated, samples regenerated, drift test green. Pure helper
  `detectInternalLinkingIssues()` in `issue-detector.ts` is unit-tested.
- **ESLint gate** (`34638e8`, pushed): `eslint.config.mjs` (ESLint 9 flat config);
  `npm run lint` works. `no-explicit-any` is `warn` (tsc --strict is the real
  type gate). 0 errors, ~85 any-warnings.
- **API keys** (`c8f35d2`): user-facing `/api/keys` endpoints
  (GET list / POST create / POST `:id/revoke`), behind the JWT `authMiddleware`,
  scoped to `req.user`, reusing `generateApiKey()` (no key crypto duplicated).
  Gated by `profiles.api_access`. The CLI (`npm run apikey`) is unchanged.

## Deployed vs not

- Pushed to GitHub `main`: F-D12 and the ESLint commit.
- **NOT deployed yet** until you deploy via Coolify: the API-key endpoints
  (`c8f35d2`) and the F-D12 issue detection both need the crawler redeployed.
- `deep_page` / `weak_internal_linking` only appear **after a re-scan** of each
  project once the crawler is deployed (they are computed at scan time; no
  backfill).

## What you must do

1. **Apply migrations** in Supabase Studio SQL editor, in this order. All are
   safe to re-run:
   - `migrations/2026-10-22_0001_v1_jobs_api.sql`
   - `migrations/2026-10-23_0001_v1_jobs_api_hardening.sql`
   - `migrations/2026-10-24_0001_v1_stage4.sql`
   - `migrations/2026-10-24_0002_v1_stage4_retention.sql`
   - `migrations/2026-10-28_0001_profiles_api_access.sql`  ← **new this session**

   The first four create `api_keys` / `api_key_usage` / `api_jobs` and Stage-4
   retention — if they were already applied, re-running is a no-op. The last adds
   `profiles.api_access`. **Until `profiles.api_access` exists, the `/api/keys`
   create endpoint fails closed (403 for everyone), so apply it before deploying.**
2. **Regenerate types** with supatypes after the migration, so `profiles.api_access`
   is in `src/database.types.ts`. Interim: `src/routes/keys.ts` reads `api_access`
   through a small cast — no shim to delete, but regenerating is cleaner.
3. **Deploy the crawler** via Coolify.
4. No new env vars. (Existing: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ALLOWED_ORIGINS` incl. the app origin, crawler UA / egress / proxy as already
   set.)

## Backlog (priority order)

1. **Billing (Paddle → Stripe)** — waiting on your decisions; don't touch billing
   code until then. When it lands, make `profiles.api_access` (and API rate/quota
   tiers) driven by the plan instead of a manual admin grant.
2. **Database backups** — no automated backup of the self-hosted Supabase is set
   up. Decide cadence/retention/offsite (R2 Oceania) and wire it.
3. **Deferred / smaller:**
   - `preload` rel-regex counts `dns-prefetch` as a preload in the parser
     (`\bprefetch\b` also matches `dns-prefetch`) — cosmetic, not user-facing.
   - `no-explicit-any` is `warn`; tighten to error per-area once boundaries are
     typed.
   - Roadmap (see memory `master_plan`): Web Bot Auth (RFC 9421 signatures), GSC,
     Screaming-Frog-style crawl depth.
