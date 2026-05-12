-- Migration: Allow soft-deleting projects by making user_id nullable
-- When a user "deletes" a project, user_id is set to NULL instead of deleting the row.
-- All data (pages, scans, issues, links) is preserved.

ALTER TABLE projects ALTER COLUMN user_id DROP NOT NULL;
