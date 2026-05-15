-- Migration: Add content analysis fields to pages table
-- Run this in your Supabase SQL editor before deploying the updated crawler

ALTER TABLE pages ADD COLUMN IF NOT EXISTS content_hash text DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS readability_score integer DEFAULT NULL;
