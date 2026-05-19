import { WebCrawler } from "./crawler";
import { storeScanResults } from "./database";
import { getSupabaseServiceClient } from "./database/client";
import { detectAndStoreIssues } from "./issue-detector";
import { checkAndStoreBacklinks } from "./backlink-checker";
import { AuditAnalyzer } from "./audit-analyzer";
import { storeAuditResults } from "./audit-database";
import { analyzeSiteLevelData } from "./site-analyzer";
import { detectSiteLevelIssues } from "./site-issue-detector";
import { computeNextScanAt } from "../utils/scheduler";

export async function createScanSnapshot(
  projectId: string,
  scanId: string,
  pagesScanned: number,
  issuesFound: number,
  startedAt: string,
  completedAt: string,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceClient();

    const { data: issues } = await supabase
      .from("issues")
      .select("severity")
      .eq("project_id", projectId)
      .eq("scan_id", scanId);

    const issueCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    if (issues) {
      for (const issue of issues) {
        const severity = (issue.severity?.toLowerCase() || "low") as keyof typeof issueCounts;
        if (severity in issueCounts) {
          issueCounts[severity]++;
        }
      }
    }
    const totalIssues = issueCounts.critical + issueCounts.high + issueCounts.medium + issueCounts.low;

    const { count: totalPages } = await supabase
      .from("pages")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .like("url", "http%");

    const { count: indexablePages } = await supabase
      .from("pages")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("is_indexable", true)
      .like("url", "http%");

    const { count: brokenLinks } = await supabase
      .from("page_links")
      .select("*", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("is_broken", true);

    const { data: pagesWithData } = await supabase
      .from("pages")
      .select("title, meta_description, h1s")
      .eq("project_id", projectId)
      .like("url", "http%");

    let avgSeoScore = 0;
    if (pagesWithData && pagesWithData.length > 0) {
      const scores = pagesWithData.map((page) => {
        let score = 100;
        if (!page.title) score -= 20;
        if (!page.meta_description) score -= 15;
        const h1Count = Array.isArray(page.h1s) ? page.h1s.length : 0;
        if (h1Count === 0) score -= 15;
        else if (h1Count > 1) score -= 5;
        return Math.max(0, score);
      });
      avgSeoScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }

    const snapshotData = {
      timestamp: new Date().toISOString(),
      metrics: {
        totalPages: totalPages || 0,
        indexablePages: indexablePages || 0,
        brokenLinks: brokenLinks || 0,
        avgSeoScore,
      },
      issues: {
        total: totalIssues,
        critical: issueCounts.critical,
        high: issueCounts.high,
        medium: issueCounts.medium,
        low: issueCounts.low,
      },
      scan: {
        id: scanId,
        status: "completed",
        pagesScanned,
        issuesFound,
        startedAt,
        completedAt,
      },
    };

    const { error: snapshotError } = await supabase
      .from("scan_snapshots")
      .insert({
        scan_id: scanId,
        snapshot_data: snapshotData,
      });

    if (snapshotError) {
      console.error(`Error creating snapshot for scan ${scanId}:`, snapshotError);
    } else {
      console.log(`Snapshot created for scan ${scanId}`);
    }
  } catch (error) {
    console.error(`Failed to create snapshot for scan ${scanId}:`, error);
  }
}

export async function processAuditScan(
  url: string,
  options: any,
  scanId: string,
  projectId: string,
): Promise<void> {
  try {
    console.log(`Starting audit crawl for ${url}`);

    const crawler = new WebCrawler(url, scanId, projectId);
    const scanResults = await crawler.crawl(url, options);

    console.log(
      `Audit crawl completed for ${url}, found ${scanResults.length} pages`,
    );

    await storeScanResults(projectId, scanId, scanResults, {
      crawlCompleted: crawler.crawlCompleted,
    });

    const analyzer = new AuditAnalyzer(scanResults, url);
    const { analysis, recommendations, overallScore } =
      await analyzer.analyze();

    const auditData = {
      scan_id: scanId,
      project_id: projectId,
      modernization_score: analysis.modernization.score,
      performance_score: analysis.performance.score,
      completeness_score: analysis.completeness.score,
      conversion_score: 0,
      overall_score: overallScore,
      tech_stack: analysis.techStack,
      design_analysis: analysis.design,
      missing_pages: analysis.completeness.missingPages,
      found_pages: analysis.completeness.foundPages,
      performance_metrics: analysis.performance,
      modern_standards: analysis.modernStandards,
      recommendations: recommendations,
    };

    await storeAuditResults(projectId, scanId, auditData);

    let siteLevelData;
    try {
      siteLevelData = await analyzeSiteLevelData(url, scanResults);
      console.log(
        `Audit site-level analysis complete: robots.txt=${siteLevelData.robots_txt?.exists}, sitemap=${siteLevelData.sitemap_validation?.found}`,
      );
    } catch (error) {
      console.error("Site-level analysis failed (non-critical):", error);
    }

    const issuesFound = await detectAndStoreIssues(
      scanResults,
      projectId,
      scanId,
    );

    let siteIssuesFound = 0;
    if (siteLevelData) {
      try {
        const supabaseForLookup = getSupabaseServiceClient();
        const { data: homepagePage } = await supabaseForLookup
          .from("pages")
          .select("id")
          .eq("project_id", projectId)
          .eq("depth", 0)
          .limit(1)
          .single();

        siteIssuesFound = await detectSiteLevelIssues(
          siteLevelData,
          projectId,
          scanId,
          homepagePage?.id || null,
        );
      } catch (error) {
        console.error("Site-level issue detection failed:", error);
      }
    }

    const backlinksFound = await checkAndStoreBacklinks(projectId, url);

    const supabase = getSupabaseServiceClient();
    const completedAt = new Date().toISOString();
    const totalIssues = issuesFound + siteIssuesFound;

    const totalLinksScanned = scanResults.reduce(
      (total, page) => total + page.internal_links.length + page.external_links.length,
      0,
    );

    const { data: auditScanRecord } = await supabase
      .from("scans")
      .select("started_at, summary_stats")
      .eq("id", scanId)
      .single();

    const auditMergedStats = {
      ...(typeof auditScanRecord?.summary_stats === "object" && auditScanRecord.summary_stats !== null
        ? auditScanRecord.summary_stats as Record<string, unknown>
        : {}),
      overall_score: overallScore,
      recommendations_count: recommendations.length,
      issues_found: totalIssues,
      backlinks_found: backlinksFound,
      ...(siteLevelData && { site_level_data: siteLevelData }),
    };

    await supabase
      .from("scans")
      .update({
        status: "completed",
        completed_at: completedAt,
        pages_scanned: scanResults.length,
        links_scanned: totalLinksScanned,
        issues_found: totalIssues,
        summary_stats: JSON.parse(JSON.stringify(auditMergedStats)),
      })
      .eq("id", scanId);

    await createScanSnapshot(
      projectId,
      scanId,
      scanResults.length,
      totalIssues,
      auditScanRecord?.started_at || completedAt,
      completedAt,
    );

    const { data: auditProjectData } = await supabase
      .from("projects")
      .select("scan_frequency")
      .eq("id", projectId)
      .single();

    const auditProjectUpdate: any = { last_scan_at: completedAt };
    if (auditProjectData?.scan_frequency) {
      const nextScanAt = computeNextScanAt(new Date(), auditProjectData.scan_frequency);
      if (nextScanAt) {
        auditProjectUpdate.next_scan_at = nextScanAt.toISOString();
      }
    }
    await supabase
      .from("projects")
      .update(auditProjectUpdate)
      .eq("id", projectId);

    console.log(
      `Audit scan completed for project ${projectId}, scan ${scanId}, score: ${overallScore}/100, ${issuesFound} issues found, ${backlinksFound} backlinks discovered`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);
    console.error(`Error in audit scan process for scan ${scanId}:`, errorMessage, error);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const supabase = getSupabaseServiceClient();
        await supabase
          .from("scans")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            summary_stats: {
              error_message: errorMessage,
              failed_at: new Date().toISOString(),
            },
          })
          .eq("id", scanId);
        break;
      } catch (dbError) {
        console.error(
          `Failed to update scan ${scanId} status to failed (attempt ${attempt + 1}/3):`,
          dbError,
        );
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
}
