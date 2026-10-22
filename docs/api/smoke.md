# /api/v1 production smoke test

A five-minute check that the live jobs API works end to end: mint one key, run
one scan on a small site you own, read the result, then revoke the key. Do this
once after deploying the Stage 3 changes.

**Prerequisites**

- The crawler is deployed with the `/api/v1` router (this branch) and the
  migration `2026-10-22_0001_v1_jobs_api.sql` is applied to production. Applying
  the defence-in-depth `2026-10-23_0001_v1_jobs_api_hardening.sql` first is
  recommended but not required for the smoke test.
- You can run the operator CLI against production (its shell has the production
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`).
- A small project you own in RankRiot. Note its **project id** and your
  **user id** (both are UUIDs from the dashboard / Supabase).
- `CRAWLER` below is your crawler's base URL, e.g.
  `https://crawler.rankriot.app`.

---

## 1. Mint a key (shown once)

```bash
npx ts-node src/scripts/api-key.ts create \
  --user <your-user-uuid> \
  --scopes jobs:read,jobs:write \
  --label "smoke-test $(date +%F)" \
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

**If anything fails**, check: the key's `scopes` include what the endpoint needs
(`jobs:write` to create/cancel, `jobs:read` to read); the project id is yours;
the crawler host is reachable; and the migration is applied (a `500
database_error` on create usually means the `api_jobs` table is missing).
