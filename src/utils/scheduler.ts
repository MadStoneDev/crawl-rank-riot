import { WebCrawler } from "../services/crawler";
import { storeScanResults } from "../services/database";
import { getSupabaseClient } from "../services/database/client";

export class CrawlScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log("Starting crawl scheduler...");

    // Check every hour for projects that need recrawling
    this.intervalId = setInterval(
      () => {
        this.checkAndScheduleCrawls();
      },
      60 * 60 * 1000,
    ); // 1 hour

    // Run initial check
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
      const supabase = getSupabaseClient();

      // Find projects that need recrawling (weekly)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const { data: projects, error } = await supabase
        .from("projects")
        .select("*")
        .or(`last_scan_at.is.null,last_scan_at.lt.${weekAgo.toISOString()}`)
        .eq("scan_frequency", "weekly");

      if (error) {
        console.error("Error fetching projects for scheduling:", error);
        return;
      }

      if (!projects || projects.length === 0) {
        console.log("No projects need recrawling at this time");
        return;
      }

      console.log(`Found ${projects.length} projects that need recrawling`);

      // Process each project (with some delay between them)
      for (const project of projects) {
        await this.crawlProject(project);
        // Wait 30 seconds between projects to avoid overwhelming the server
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
      const supabase = getSupabaseClient();

      // Create a new scan record
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

      // Run the crawler
      const crawler = new WebCrawler(project.url);
      const results = await crawler.crawl(project.url, {
        maxDepth: 3,
        maxPages: 100,
        concurrentRequests: 2, // Lower concurrency for scheduled crawls
        timeout: 300000, // 5 minutes
      });

      console.log(
        `Scheduled crawl completed for ${project.url}: ${results.length} pages`,
      );

      // Store results
      await storeScanResults(project.id, scanId, results);

      // Update project last_scan_at
      await supabase
        .from("projects")
        .update({ last_scan_at: new Date().toISOString() })
        .eq("id", project.id);

      // Mark scan as completed
      await supabase
        .from("scans")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
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

      // Mark scan as failed if we have scanId
      const supabase = getSupabaseClient();
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
        })
        .eq("project_id", project.id)
        .eq("status", "in_progress");
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const crawlScheduler = new CrawlScheduler();
