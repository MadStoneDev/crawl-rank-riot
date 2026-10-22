-- Stage 4: additive API surface for Vanward — projects, job attribution,
-- job scope + module selection, and per-job page snapshots.
--
-- NOT YET APPLIED. A human applies this (see migrations/README.md). After
-- applying, regenerate src/database.types.ts and delete the Stage 4 typed shim
-- (src/services/api/v1/stage4-db.ts). All changes are additive: existing rows,
-- columns, endpoints and behaviour are unchanged.

-- ---------------------------------------------------------------------------
-- api_jobs: attribution (external_ref + metadata) and the new scope / module
-- selection. All nullable or defaulted so existing rows and the existing
-- create path are unaffected (scope defaults to today's full-site behaviour,
-- modules null = full pipeline).
-- ---------------------------------------------------------------------------
alter table public.api_jobs add column if not exists external_ref text;
alter table public.api_jobs add column if not exists metadata jsonb not null default '{}';
alter table public.api_jobs add column if not exists scope text not null default 'site';
alter table public.api_jobs add column if not exists modules jsonb;        -- null = full pipeline
alter table public.api_jobs add column if not exists result jsonb;         -- module summaries (e.g. site-level tech fingerprint)

do $$ begin
  alter table public.api_jobs add constraint api_jobs_scope_check check (scope in ('site', 'page', 'urls'));
exception when duplicate_object then null; end $$;

create index if not exists api_jobs_external_ref_idx on public.api_jobs (api_key_id, external_ref);

-- ---------------------------------------------------------------------------
-- api_projects: API-managed attributes for a project (external_ref + metadata),
-- kept in a side table so the shared `projects` table is untouched. One row per
-- project; the project itself still lives in `projects` (owned by the user).
-- ---------------------------------------------------------------------------
create table if not exists public.api_projects (
  project_id    uuid primary key references public.projects (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  external_ref  text,
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists api_projects_user_id_idx on public.api_projects (user_id);
create index if not exists api_projects_external_ref_idx on public.api_projects (user_id, external_ref);

-- ---------------------------------------------------------------------------
-- api_job_pages: a per-job snapshot of the pages a job's scan produced, with
-- the cleaned main text and the selected modules' per-page outputs.
--
-- This is deliberately self-contained rather than read live from `pages`: the
-- shared `pages` table is project-scoped and overwritten by each later scan, so
-- GET /jobs/:id/pages could otherwise return a different scan's data. `data`
-- holds the standard extracted fields; `content` holds the cleaned main text
-- (served only on ?include=content); `modules` holds tech_fingerprint /
-- business_info output for that page.
-- ---------------------------------------------------------------------------
create table if not exists public.api_job_pages (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.api_jobs (id) on delete cascade,
  page_id     uuid references public.pages (id) on delete set null,
  url         text not null,
  http_status integer,
  data        jsonb not null default '{}',   -- standard per-page fields (no heavy text)
  content     text,                           -- cleaned main text (nullable)
  modules     jsonb not null default '{}',    -- { tech_fingerprint: {...}, business_info: {...} }
  created_at  timestamptz not null default now(),
  unique (job_id, url)
);

create index if not exists api_job_pages_job_id_idx on public.api_job_pages (job_id);

-- RLS: written only by the crawler's service-role client (bypasses RLS). Enable
-- with no permissive policies so anon/authenticated cannot read these directly
-- — same posture as the Stage 3 tables.
alter table public.api_projects enable row level security;
alter table public.api_job_pages enable row level security;
