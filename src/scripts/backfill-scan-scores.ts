/**
 * One-off backfill: compute and persist the canonical ScoreReport for legacy
 * SEO scans that predate scan_scores.
 *
 * IMPORTANT — why latest-scan-only:
 * The `pages` table is upserted per (project_id, url) — it holds current state
 * only, not a per-scan snapshot. So the current page rows faithfully represent
 * ONLY each project's most recent completed scan; older scans' page data has
 * been overwritten. We therefore backfill exactly one row per project: the
 * latest completed SEO scan. That is also precisely the scan the dashboard and
 * project detail page read, so it is what the fallback needs. Older scans keep
 * their trend-chart entry (scan_snapshots), which already carries the canonical
 * overall going forward.
 *
 * Safe to re-run: skips any scan that already has a scan_scores row. Supports
 * --dry-run (compute + report, write nothing).
 *
 * Run from the crawler repo:
 *   npx ts-node src/scripts/backfill-scan-scores.ts --dry-run
 *   npx ts-node src/scripts/backfill-scan-scores.ts
 */

// Load .env as the very first side effect, before any import reads process.env.
// The normal app entry does this via src/config/index.ts; this standalone script
// must do it itself. `import "dotenv/config"` runs dotenv.config() at import
// time, ahead of the imports below (import side effects run in order).
import "dotenv/config";
import { getSupabaseServiceClient } from "../services/database/client";
import { computeScoreReport } from "../scoring/score-report";
import { ScanResult } from "../types";

const DRY_RUN = process.argv.includes("--dry-run");

/** Map a `pages` DB row (snake_case, current-state) to the ScanResult fields
 *  the scorer reads. Only the scoring-relevant fields are populated. */
function pageRowToScanResult(row: any): ScanResult {
  return {
    url: row.url,
    status: row.http_status ?? 0,
    title: row.title ?? undefined,
    meta_description: row.meta_description ?? undefined,
    depth: row.depth ?? 0,
    h1s: Array.isArray(row.h1s) ? row.h1s : [],
    h2s: [],
    h3s: [],
    h4s: [],
    h5s: [],
    h6s: [],
    content_length: row.content_length ?? 0,
    word_count: row.word_count ?? 0,
    canonical_url: row.canonical_url ?? null,
    is_indexable: !!row.is_indexable,
    has_robots_noindex: !!row.has_robots_noindex,
    has_robots_nofollow: !!row.has_robots_nofollow,
    open_graph: (row.open_graph && typeof row.open_graph === "object" ? row.open_graph : {}) as Record<string, string>,
    twitter_card: {},
    internal_links: [],
    external_links: [],
    images: Array.isArray(row.images) ? row.images : [],
    redirect_url: row.redirect_url ?? null,
    content_type: row.content_type ?? "",
    size_bytes: row.size_bytes ?? 0,
    load_time_ms: row.load_time_ms ?? 0,
    first_byte_time_ms: row.first_byte_time_ms ?? 0,
    structured_data: Array.isArray(row.structured_data) ? row.structured_data : [],
    schema_types: Array.isArray(row.schema_types) ? row.schema_types : [],
    js_count: row.js_count ?? 0,
    css_count: row.css_count ?? 0,
    keywords: [],
    scanned_at: row.updated_at ?? row.created_at ?? new Date().toISOString(),
  };
}

async function main() {
  const supabase = getSupabaseServiceClient();
  console.log(`Backfill scan_scores${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);

  // All SEO projects.
  const { data: projects, error: projErr } = await supabase
    .from("projects")
    .select("id, url, project_type");
  if (projErr) throw projErr;

  const seoProjects = (projects || []).filter(
    (p: any) => (p.project_type ?? "seo") === "seo",
  );
  console.log(`Found ${seoProjects.length} SEO project(s).`);

  let scored = 0;
  let skippedExisting = 0;
  let skippedNoPages = 0;

  for (const project of seoProjects) {
    // Latest completed SEO scan for this project.
    const { data: scans } = await supabase
      .from("scans")
      .select("id, summary_stats, completed_at")
      .eq("project_id", project.id)
      .eq("scan_type", "seo")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);

    const scan = scans?.[0];
    if (!scan) continue;

    // Already has a canonical row? Skip (idempotent re-run).
    const { data: existing } = await supabase
      .from("scan_scores")
      .select("scan_id")
      .eq("scan_id", scan.id)
      .limit(1);
    if (existing && existing.length > 0) {
      skippedExisting++;
      continue;
    }

    // Current pages == this latest scan's state.
    const { data: pages } = await supabase
      .from("pages")
      .select(
        "url, http_status, is_indexable, has_robots_noindex, has_robots_nofollow, title, meta_description, word_count, content_length, h1s, load_time_ms, first_byte_time_ms, canonical_url, redirect_url, content_type, size_bytes, images, structured_data, schema_types, open_graph, js_count, css_count, depth, created_at, updated_at",
      )
      .eq("project_id", project.id)
      .like("url", "http%");

    if (!pages || pages.length === 0) {
      skippedNoPages++;
      continue;
    }

    const stats = (scan.summary_stats && typeof scan.summary_stats === "object"
      ? (scan.summary_stats as any)
      : {}) as any;
    const blocked = !!stats.bot_protection?.blocked;

    const results = pages.map(pageRowToScanResult);
    const report = computeScoreReport(results, { blocked });

    console.log(
      `  ${project.url} — scan ${scan.id.slice(0, 8)} — overall ${report.overall}${blocked ? " (blocked)" : ""} from ${pages.length} pages`,
    );

    if (DRY_RUN) {
      scored++;
      continue;
    }

    const { error: scoreErr } = await supabase.from("scan_scores").upsert(
      {
        scan_id: scan.id,
        project_id: project.id,
        version: report.version,
        overall: report.overall,
        technical: report.categories.technical.score,
        content: report.categories.content.score,
        media: report.categories.media.score,
        aeo: report.categories.aeo.score,
        geo: null,
        blocked: report.blocked,
        report: JSON.parse(JSON.stringify(report)),
      },
      { onConflict: "scan_id" },
    );
    if (scoreErr) {
      console.error(`  ! failed scan_scores for ${scan.id}: ${scoreErr.message}`);
      continue;
    }

    // Also set the flat summary_stats.seo_score so the frontend's primary read
    // path works immediately (it prefers this over the fallback).
    const mergedStats = {
      ...stats,
      seo_score: {
        technical: report.categories.technical.score,
        content: report.categories.content.score,
        media: report.categories.media.score,
        aeo: report.categories.aeo.score,
        overall: report.overall,
      },
    };
    const { error: statsErr } = await supabase
      .from("scans")
      .update({ summary_stats: JSON.parse(JSON.stringify(mergedStats)) })
      .eq("id", scan.id);
    if (statsErr) {
      console.error(`  ! failed summary_stats for ${scan.id}: ${statsErr.message}`);
    }

    scored++;
  }

  console.log(
    `\nDone. scored=${scored}, skipped(existing)=${skippedExisting}, skipped(no pages)=${skippedNoPages}${DRY_RUN ? " [dry run]" : ""}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
