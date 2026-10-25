# /api/v1 production smoke test

A five-minute check that the live jobs API works end to end: mint one key, run
one scan on a small site you own, read the result, then revoke the key. Do this
once after deploying the Stage 3 changes.

**Prerequisites**

- The crawler is deployed with the `/api/v1` router (this branch) and the
  migrations `2026-10-22_0001_v1_jobs_api.sql` and (for the Stage 4 projects /
  pages / scope / modules features) `2026-10-24_0001_v1_stage4.sql` are applied
  to production, with `database.types.ts` regenerated. Applying the
  defence-in-depth `2026-10-23_0001_v1_jobs_api_hardening.sql` first is
  recommended but not required for the smoke test.
- You can run the operator CLI against the production database. It reads
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`) and
  loads a `.env` from the repo root on its own (`import "dotenv/config"`), so
  either point `.env` at production or pass the two vars inline / exported.
- A small site to scan. The project must belong to the **service user** (step
  0) — create it via `POST /api/v1/projects` with the key (step 3), or add it in
  the dashboard as that user, and note its **project id**.
- `CRAWLER` below is your crawler's base URL, e.g.
  `https://crawler.rankriot.app`.

---

## 0. Create a dedicated service user for Vanward

Mint the key under a **dedicated RankRiot user for Vanward**, not your own
account, so its usage, projects and jobs are isolated and the key can be
revoked without touching you.

1. Create the user (one of):
   - Supabase dashboard → Authentication → **Add user** (email you control,
     e.g. `vanward@rankriot.app`, mark email confirmed); or
   - `supabase.auth.admin.createUser({ email, email_confirm: true })` with the
     service role.
2. Note its **user UUID** (Authentication → Users, or `auth.users`). Use it as
   `--user` below.
3. **Internal plan / no page caps:** if you keep a `profiles`/`subscription`
   row per user, set this user to your internal/unlimited tier. This is for the
   app UI and your own bookkeeping only — see the note below; it does **not**
   change what API jobs are allowed to crawl.

### Do plan caps apply to API jobs?

**No — the crawler does not apply per-user plan page caps to `/api/v1` jobs.**
Plan enforcement (e.g. `subscription_plans.max_pages_per_scan`) lives in the
RankRiot **app** (`rank-riot`) ahead of its `/api/scan` call; the crawler's
`scan-pipeline` contract states the *caller* owns plan limits, and the `/v1`
path calls the pipeline directly, so no plan/page cap is read there. An API
job is bounded only by:

- the request's `options`, **clamped** server-side to hard ceilings
  (`maxPages` ≤ 100,000 for `seo` / ≤ 500 for `audit`; `maxDepth` ≤ 10 / 5) in
  `clampOptions` (`src/routes/v1/jobs.ts`);
- the API key's **`monthly_quota`** (jobs created/month) and
  **`rate_limit_per_min`** (`api_keys`, set when minting);
- **one scan per project** at a time (`409 scan_in_progress`);
- for `page`/`urls` scope, the explicit URL set (≤ 50, same-domain).

So the Vanward service user needs no special plan for the API to work at full
size. If you later want to *limit* Vanward, do it on the key (`monthly_quota`,
`rate_limit_per_min`), not via a plan.

## 1. Mint a key (shown once)

The CLI loads `.env` itself, so with a production `.env` present you can run it
directly; otherwise prefix the command with the two vars. `npm run apikey -- …`
works the same as the `npx ts-node …` form below.

```bash
# If .env does not point at production, prefix with:
#   SUPABASE_URL='…' SUPABASE_SERVICE_ROLE_KEY='…' \
npx ts-node src/scripts/api-key.ts create \
  --user <vanward-service-user-uuid> \
  --scopes jobs:read,jobs:write,projects:read,projects:write \
  --label "vanward $(date +%F)" \
  --rate 60 --quota 10 --env live
```

Copy the `rrk_live_…` value it prints — it is shown only once. Export it and the
key id:

```bash
export RRK="rrk_live_…"
export KEY_ID="<id printed above>"
export CRAWLER="https://crawler.rankriot.app"
export PROJECT="<your-project-uuid>"
```

## 2. Confirm the key authenticates

```bash
curl -s "$CRAWLER/api/v1/usage" -H "Authorization: Bearer $RRK" | jq
```

Expect an `object: "usage"` body with `requests`/`jobs_created` and your quota.

## 3. Create a job (start a scan)

```bash
curl -s -X POST "$CRAWLER/api/v1/jobs" \
  -H "Authorization: Bearer $RRK" -H "Content-Type: application/json" \
  -d "{\"type\":\"seo\",\"project_id\":\"$PROJECT\",\"options\":{\"maxPages\":10}}" | jq
```

Expect `202` and `data.status: "running"`. Save the job id:

```bash
export JOB="<data.id from above>"
```

## 4. Poll until it finishes

```bash
curl -s "$CRAWLER/api/v1/jobs/$JOB" -H "Authorization: Bearer $RRK" | jq '.data.status, .data.stats'
```

Repeat every few seconds until `status` is `completed` (a 10-page site is quick).
`failed` with a `failure_reason` is also a valid outcome to observe (e.g. if the
site blocks the crawler) — the point is the lifecycle works.

## 5. Read the report and issues

```bash
curl -s "$CRAWLER/api/v1/jobs/$JOB/report" -H "Authorization: Bearer $RRK" | jq '.data.overall, .data.categories'
curl -s "$CRAWLER/api/v1/jobs/$JOB/issues?limit=5" -H "Authorization: Bearer $RRK" | jq '.data.page, [.data.items[] | {type, category, category_label, severity, is_speed}]'
```

Check: four categories with `score` + `pass_rate`; issues each carry `category`,
`category_label`, `severity` and `is_speed`. This is the shape Vanward consumes
(see [`v1.md`](./v1.md) and [`samples/`](./samples/)).

## 6. Revoke the key

```bash
npx ts-node src/scripts/api-key.ts revoke --id "$KEY_ID"
```

Confirm it no longer works:

```bash
curl -s "$CRAWLER/api/v1/usage" -H "Authorization: Bearer $RRK" | jq
# expect 401 key_revoked
```

## 7. (Optional) tidy up

The smoke scan created a real scan + report for your project, visible in the
dashboard like any scan. Delete it there if you don't want to keep it. The
revoked key row can stay (revoked keys are harmless) or be removed in Supabase.

---

To also smoke-test Stage 4: `POST /api/v1/projects {domain,name}` (needs
`projects:write`), then a page-scope extraction job
`POST /api/v1/jobs {project_id, scope:"page", modules:["fetch_extract","tech_fingerprint","business_info"]}`,
then `GET /api/v1/jobs/:id/pages` and `.../pages/:pageId?include=content`.

**If anything fails**, check: the key's `scopes` include what the endpoint needs
(`jobs:write` to create/cancel, `jobs:read` to read); the project id is yours;
the crawler host is reachable; and the migration is applied (a `500
database_error` on create usually means the `api_jobs` table is missing).
