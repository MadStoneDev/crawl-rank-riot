import { WebCrawler } from "../services/crawler";
import { storeScanResults } from "../services/database";
import { getSupabaseServiceClient } from "../services/database/client";

export function computeNextScanAt(
  fromDate: Date,
  frequency: string,
): Date | null {
  const next = new Date(fromDate);
  switch (frequency) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      return next;
    default:
      return null;
  }
}

export class CrawlScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log("Starting crawl scheduler...");

    this.intervalId = setInterval(
      () => {
        this.checkAndScheduleCrawls();
      },
      60 * 60 * 1000,
    );

    this.checkAndScheduleCrawls();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log("Crawl scheduler stopped");
  }

  private async checkAndScheduleCrawls(): Promise<void> {
    try {
      const supabase = getSupabaseServiceClient();
      const now = new Date().toISOString();

      const { data: projects, error } = await supabase
        .from("projects")
        .select("*")
        .not("scan_frequency", "eq", "manual")
        .not("scan_frequency", "is", null)
        .is("deleted_at", null)
        .lte("next_scan_at", now);

      if (error) {
        console.error("Error fetching projects for scheduling:", error);
        return;
      }

      if (!projects || projects.length === 0) {
        console.log("No projects need recrawling at this time");
        return;
      }

      console.log(`Found ${projects.length} projects that need recrawling`);

      for (const project of projects) {
        await this.crawlProject(project);
        await this.delay(30000);
      }
    } catch (error) {
      console.error("Error in crawl scheduler:", error);
    }
  }

  private async crawlProject(project: any): Promise<void> {
    console.log(
      `Starting scheduled crawl for project: ${project.name} (${project.url})`,
    );

    try {
      const supabase = getSupabaseServiceClient();

      const { data: scanData, error: scanError } = await supabase
        .from("scans")
        .insert({
          project_id: project.id,
          status: "in_progress",
          started_at: new Date().toISOString(),
          pages_scanned: 0,
          links_scanned: 0,
          issues_found: 0,
        })
        .select()
        .single();

      if (scanError) {
        console.error(
          `Failed to create scan record for project ${project.id}:`,
          scanError,
        );
        return;
      }

      const scanId = scanData.id;

      const scheduledMaxPages = 500;
      const crawler = new WebCrawler(project.url, scanId, project.id);
      const results = await crawler.crawl(project.url, {
        maxDepth: 3,
        maxPages: scheduledMaxPages,
        concurrentRequests: 2,
        timeout: Math.max(300_000, scheduledMaxPages * 2_000),
      });

      console.log(
        `Scheduled crawl completed for ${project.url}: ${results.length} pages`,
      );

      await storeScanResults(project.id, scanId, results);

      const now = new Date();
      const nextScanAt = computeNextScanAt(now, project.scan_frequency);

      await supabase
        .from("projects")
        .update({
          last_scan_at: now.toISOString(),
          next_scan_at: nextScanAt ? nextScanAt.toISOString() : null,
        })
        .eq("id", project.id);

      await supabase
        .from("scans")
        .update({
          status: "completed",
          completed_at: now.toISOString(),
          pages_scanned: results.length,
        })
        .eq("id", scanId);

      console.log(
        `Scheduled crawl successfully completed for project: ${project.name}`,
      );
    } catch (error) {
      console.error(
        `Error in scheduled crawl for project ${project.id}:`,
        error,
      );

      const supabase = getSupabaseServiceClient();
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("project_id", project.id)
        .eq("status", "in_progress");

      // Still advance next_scan_at so we don't retry endlessly on failure
      const nextScanAt = computeNextScanAt(
        new Date(),
        project.scan_frequency,
      );
      if (nextScanAt) {
        await supabase
          .from("projects")
          .update({ next_scan_at: nextScanAt.toISOString() })
          .eq("id", project.id);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const crawlScheduler = new CrawlScheduler();
