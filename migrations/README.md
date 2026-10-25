# Database migrations

Raw SQL migrations for the RankRiot crawler's Supabase database.

## Convention

- One file per logical change, named `YYYY-MM-DD_NNNN_short_name.sql` where
  `NNNN` is a zero-padded sequence within that day (`0001`, `0002`, …).
- Apply in filename (date, then sequence) order.
- Migrations are **append-only**: once a file has been applied to any
  environment, never edit it — write a new migration instead.
- Each file is idempotent where practical (`create table if not exists`,
  `create index if not exists`) so re-running is safe.

The earlier unnumbered files (`add_*.sql`, `soft_delete_projects.sql`) predate
this convention and are kept as-is.

## Applying

These are applied manually by an operator against the target database (e.g. via
the Supabase SQL editor or `psql`). Nothing in the app runs them automatically,
and they are **never** applied to production as part of this audit — a human
reviews and applies them.

## Generated types

`src/database.types.ts` is generated from the live schema (supatypes). After a
migration is applied to the database, regenerate the types so the code sees the
new tables/columns.
