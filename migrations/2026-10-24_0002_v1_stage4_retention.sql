-- Stage 4 retention: index to support purging old per-job page snapshots.
--
-- NOT YET APPLIED. Apply after 2026-10-24_0001_v1_stage4.sql. The crawler's
-- scheduler deletes api_job_pages rows (and their stored cleaned content) older
-- than API_JOB_PAGES_RETENTION_DAYS (default 90) on its hourly tick; this index
-- keeps that delete (a range scan on created_at) cheap as the table grows.

create index if not exists api_job_pages_created_at_idx
  on public.api_job_pages (created_at);
