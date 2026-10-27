-- API-key management: per-user gate for the user-facing API-key screen.
--
-- `api_access` controls whether a user may create/manage their own rrk_ API
-- keys from the app. Default OFF; an admin grants it per user from the admin
-- area. Billing will drive this later (Paddle -> Stripe), but for now it is a
-- manual admin grant and MUST NOT be tied to billing.
--
-- Safe to re-run.
alter table public.profiles
  add column if not exists api_access boolean not null default false;
