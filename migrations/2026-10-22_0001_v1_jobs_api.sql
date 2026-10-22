-- Stage 3: public /api/v1 jobs API — scoped API keys, jobs, and per-key usage.
--
-- NOT YET APPLIED to any environment. A human applies this (see migrations/
-- README.md). After applying, regenerate src/database.types.ts.

-- ---------------------------------------------------------------------------
-- api_keys: scoped, hashed API keys for the /v1 jobs API.
-- The full key is shown to the user exactly once at creation; only its SHA-256
-- hash is stored. `key_prefix` (the first 16 chars, non-secret) is indexed for
-- O(1) lookup before the constant-time hash comparison.
-- ---------------------------------------------------------------------------
create table if not exists public.api_keys (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  name               text not null,
  key_prefix         text not null unique,
  key_hash           text not null,
  -- e.g. '{jobs:read,jobs:write}'
  scopes             text[] not null default '{}',
  -- per-key rate limit (requests/minute) and optional monthly job quota.
  rate_limit_per_min integer not null default 60,
  monthly_quota      integer,                 -- null = unlimited
  status             text not null default 'active',  -- 'active' | 'revoked'
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  revoked_at         timestamptz,
  constraint api_keys_status_check check (status in ('active', 'revoked'))
);

create index if not exists api_keys_user_id_idx on public.api_keys (user_id);

-- ---------------------------------------------------------------------------
-- api_jobs: a scan exposed as a public job. The job id is the public handle
-- (so internal scan ids never leak); `scan_id` links to the scan that does the
-- work. One job per scan.
-- ---------------------------------------------------------------------------
create table if not exists public.api_jobs (
  id          uuid primary key default gen_random_uuid(),
  api_key_id  uuid not null references public.api_keys (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  project_id  uuid not null references public.projects (id) on delete cascade,
  scan_id     uuid references public.scans (id) on delete set null,
  type        text not null,                  -- 'seo' | 'audit'
  request     jsonb not null default '{}',    -- the create request (options)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint api_jobs_type_check check (type in ('seo', 'audit'))
);

create index if not exists api_jobs_api_key_id_idx on public.api_jobs (api_key_id);
create index if not exists api_jobs_scan_id_idx on public.api_jobs (scan_id);
create unique index if not exists api_jobs_scan_id_unique on public.api_jobs (scan_id)
  where scan_id is not null;

-- ---------------------------------------------------------------------------
-- api_key_usage: per-key, per-UTC-day counters for metering. Monthly usage is
-- the sum of a key's rows for the month.
-- ---------------------------------------------------------------------------
create table if not exists public.api_key_usage (
  api_key_id   uuid not null references public.api_keys (id) on delete cascade,
  day          date not null,
  requests     integer not null default 0,
  jobs_created integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (api_key_id, day)
);

-- Atomic per-day increment used by the usage recorder (avoids a read-modify-
-- write race across concurrent requests).
create or replace function public.increment_api_key_usage(
  p_api_key_id uuid,
  p_day        date,
  p_requests   integer,
  p_jobs       integer
) returns void language sql as $$
  insert into public.api_key_usage (api_key_id, day, requests, jobs_created, updated_at)
  values (p_api_key_id, p_day, p_requests, p_jobs, now())
  on conflict (api_key_id, day) do update
    set requests     = public.api_key_usage.requests + excluded.requests,
        jobs_created = public.api_key_usage.jobs_created + excluded.jobs_created,
        updated_at   = now();
$$;

-- RLS: these tables are written only by the crawler's service-role client
-- (which bypasses RLS). Enable RLS with no permissive policies so the anon /
-- authenticated roles cannot read keys or usage directly.
alter table public.api_keys enable row level security;
alter table public.api_jobs enable row level security;
alter table public.api_key_usage enable row level security;
