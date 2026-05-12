-- Migration: Add new scanner fields to pages table
-- Run this in your Supabase SQL editor before deploying the updated crawler

ALTER TABLE pages ADD COLUMN IF NOT EXISTS security_headers jsonb DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS redirect_chain jsonb DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS has_viewport_meta boolean DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS has_mixed_content boolean DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS heading_hierarchy_valid boolean DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS heading_hierarchy_issues jsonb DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS hreflang_tags jsonb DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS canonical_is_self boolean DEFAULT NULL;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS url_issues jsonb DEFAULT NULL;
