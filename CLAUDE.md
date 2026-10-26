# CLAUDE.md

How I (Richard, MadStoneDev / RAVENCI Solutions) build and run my projects. Follow this over any
default or "typical" setup. If something here conflicts with what a task seems to need, ask me
before doing it differently.

---

## This project: RankRiot

- **What it is:** an SEO/AEO/GEO site crawler and audit app (rankriot.app). It has two repos:
  - `crawl-rank-riot`: the crawler, the scan pipeline and the public `/api/v1`
  - `rank-riot`: the Next.js frontend
- **Database:** Supabase self-hosted, stripped as below. Auth email goes through Supabase's
  built-in templates (the send-email hook is off) via Resend, with click/open tracking off.
- **Server:** MadStoneFourVH (Canada). **Nation-sensitive: no.**
- **Branches:** `main` only. The overhaul is merged and done; no feature branches.
- **Status:** live, with paying users and scheduled scans. Treat production with care.

### Crawler rules
- **Facts come from the crawler, not the frontend.** Scores, issues, severity and categories are
  computed and persisted once by the crawler. The frontend reads them and never recomputes.
- **Issue taxonomy:** categories are `technical`, `content`, `media`, `aeo`, with the crawler's
  `ISSUE_CATEGORY` as the source of truth, plus the cross-category `is_speed` tag. Severity comes
  from the issues table.
- **Be a good citizen:** obey robots.txt, identify as RankRiotBot, keep the SSRF guard strict by
  default. Tests inject a relaxed guard through dependencies, never through an env flag.
- **HTTP and headless paths must produce the same fields.** Map parser output to ScanResult in
  one shared place.
- **Scans must never wedge a project.** Job creation is all-or-nothing, stale scans are reaped,
  and in-progress scans are reset on startup.
- Log the underlying error server-side for every `database_error`. Never send it to the client.

### Public API (`/api/v1`)
- It's a contract: Vanward and future paying API users build against it.
- Keep `docs/api/v1.md` and `docs/api/samples/` in the crawler repo and in sync. The drift test
  must pass.
- Every response carries `api_version` and `schema_version`. Additive changes bump the minor
  version; never make a breaking change without a major bump and my OK.
- Keys use the `rrk_` prefix, stored as hash and prefix only, with scopes `jobs:*` and
  `projects:*`, plus per-key rate limits, quota and metering. Manage them with
  `npm run apikey -- create|list|revoke`.
- Page snapshots (`api_job_pages`) are kept for 90 days.

### Frontend rules
- Old URLs keep working: add permanent redirects before removing any route.
- Plan limits are enforced on the server. Billing is moving from Paddle to Stripe, so don't touch
  billing code until I've decided the details.

### Docs
- Audit and progress notes live in `docs/audit/`. Log progress in `05-progress.md`.

## Hosting

- Everything is self-hosted on my own OVHcloud VPS servers, managed with self-hosted Coolify.
  Don't suggest or set up hosted platforms (Vercel, hosted Supabase, Railway, etc.) unless I ask.
- Apps deploy from Git through Coolify. Environment variables live in Coolify, never in the repo.
- Most servers are in Canada. **Nation-sensitive apps** (Australian government or sensitive
  Australian data; e.g. TheJury, Vanward, The Milione) run on my **Sydney** server, with both the
  app and its database there.

## Databases

I use one of two, both self-hosted on Coolify:

- **Supabase (self-hosted):** for anything I expect people to actually use. I want the realtime
  and the robustness. Hosted Supabase is used **only** for QRmory.
- **PocketBase (self-hosted):** for really light work.

Don't introduce another database, ORM or auth library (Drizzle, Prisma, Better Auth, Auth.js,
etc.) unless I ask.

### My Supabase stacks are stripped down

I remove these services from every self-hosted Supabase stack:
- Analytics (Logflare)
- Vector
- Supavisor
- Storage, including MinIO and the MinIO create-bucket job (and imgproxy with it)
- Edge Functions, unless that project uses them

I also set Studio's healthcheck interval to 30s instead of 5s, and limit Kong to 1 worker
process.

So **don't write code that depends on Supabase Storage, Supavisor (pooler) connection strings,
Analytics/Logs or Vector**. Files go to Cloudflare R2. Connect directly, not through the pooler.

### Migrations

- I apply migrations **myself**, by running the SQL files in **Supabase Studio's SQL editor**.
  I don't use the Supabase CLI (`supabase link`, `db push`, `migration list`) or a local
  Supabase. I develop against the remote self-hosted instance, even for new apps.
- Every migration must be **safe to re-run**: `create table if not exists`,
  `add column if not exists`, `create or replace`, `drop policy/trigger if exists` before
  creating them, guarded enum/type creation.
- Filenames sort in the order I should run them (e.g. `2026-10-26_0001_description.sql`).
- Enable RLS on every new table. No grants to `anon`/`authenticated` unless the frontend needs them.
- Never change the schema in Studio by hand; every change is a migration file.
- At the end of any task that adds migrations, **list exactly which files I need to run, in order.**
- Never run anything against a production database yourself.

### Types

- Types are generated with **supatypes** (my own package). After I've applied migrations,
  I regenerate them. Don't hand-write database types or add interim type shims unless it's
  unavoidable, and tell me when to delete them.

## Storage

- **Cloudflare R2** for app storage, with an **Oceania** location hint.
- Avoid storing sensitive files on R2 unless it's truly necessary. Where possible, don't store
  them at all. (Example: The Milione stores no files; video is processed on the local machine and
  deleted, so nothing leaves Australia.)

## Other services

- **Upstash:** always the **Oceania** region.
- Prefer self-hosted or no external service over adding a new SaaS dependency. Ask first.

## Git

- **Default: `main` only.** Commit straight to main for normal work.
- **Platforms I expect to get busy: `main` + `beta`.** `main` is live; `beta` is the less
  stable testing branch. Currently on QRmory, TableTop Chronicles and Be.Vocl (soon JustSent and
  JustReel; Vanward once it has users).
- **Stage/phase branches only for an overhaul or revamp.**
- Commit in logical, separate commits. **Don't push, merge or deploy unless I say so.**
- Never commit secrets, `.env*` files or keys. Nothing secret in a `NEXT_PUBLIC_` variable.

## Working with me

- Stop at sensible checkpoints with a short summary: what changed, how to run it, what I need to
  do (migrations to run, env vars to set), and anything you decided on your own.
- Don't touch production (databases, deploys, live keys, billing) without asking.
- Typecheck, lint and test before saying something's done, and say which you ran.
- Browser console snippets for me should start with an immediate `console.log` saying they've
  started, so I get feedback before any async work returns.
- Interface copy: plain, direct Australian English. No exclamation marks, no hype words.
