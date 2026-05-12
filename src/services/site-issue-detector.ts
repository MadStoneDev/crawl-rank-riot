import { SiteLevelData } from "../types";
import { Json } from "../database.types";
import { getSupabaseServiceClient } from "./database/client";

interface SiteIssue {
  project_id: string;
  page_id: string;
  scan_id: string;
  issue_type: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  details: Json | null;
}

export async function detectSiteLevelIssues(
  siteLevelData: SiteLevelData,
  projectId: string,
  scanId: string,
  homepagePageId: string | null,
): Promise<number> {
  const issues: SiteIssue[] = [];

  if (!homepagePageId) {
    console.log("No homepage page ID found, skipping site-level issues");
    return 0;
  }

  const addIssue = (
    issueType: string,
    severity: SiteIssue["severity"],
    description: string,
    details: Json | null = null,
  ) => {
    issues.push({
      project_id: projectId,
      page_id: homepagePageId,
      scan_id: scanId,
      issue_type: issueType,
      severity,
      description,
      details,
    });
  };

  if (siteLevelData.llms_txt && !siteLevelData.llms_txt.exists) {
    addIssue(
      "missing_llms_txt",
      "low",
      "No llms.txt file found. This file helps AI models understand your site.",
      { url: "/llms.txt" },
    );
  }

  if (siteLevelData.robots_txt) {
    const rt = siteLevelData.robots_txt;

    if (!rt.exists) {
      addIssue(
        "missing_robots_txt",
        "medium",
        "No robots.txt file found. This file controls how search engines crawl your site.",
        { url: "/robots.txt" },
      );
    }

    if (rt.ai_bots_blocked.length > 0) {
      addIssue(
        "ai_bots_blocked",
        "low",
        `${rt.ai_bots_blocked.length} AI bot(s) blocked in robots.txt: ${rt.ai_bots_blocked.join(", ")}`,
        {
          blocked_bots: rt.ai_bots_blocked,
          allowed_bots: rt.ai_bots_allowed,
        },
      );
    }
  }

  if (siteLevelData.sitemap_validation) {
    const sv = siteLevelData.sitemap_validation;

    if (!sv.found) {
      addIssue(
        "missing_sitemap",
        "medium",
        "No XML sitemap found at /sitemap.xml. Sitemaps help search engines discover your pages.",
        { url: "/sitemap.xml" },
      );
    } else if (!sv.valid) {
      addIssue(
        "invalid_sitemap",
        "medium",
        `XML sitemap has ${sv.errors.length} error(s): ${sv.errors.join("; ")}`,
        { url: sv.url, errors: sv.errors },
      );
    }

    if (sv.found && !sv.has_lastmod) {
      addIssue(
        "sitemap_missing_lastmod",
        "low",
        "Sitemap is missing <lastmod> dates. These help search engines know when to re-crawl pages.",
        { url: sv.url },
      );
    }

    if (sv.crawled_not_in_sitemap.length > 5) {
      addIssue(
        "pages_not_in_sitemap",
        "low",
        `${sv.crawled_not_in_sitemap.length} crawled pages are not in the sitemap`,
        {
          count: sv.crawled_not_in_sitemap.length,
          sample: sv.crawled_not_in_sitemap.slice(0, 10),
        },
      );
    }
  }

  if (issues.length === 0) {
    return 0;
  }

  const supabase = getSupabaseServiceClient();
  const { error } = await supabase.from("issues").insert(issues);

  if (error) {
    console.error("Error inserting site-level issues:", error);
    return 0;
  }

  console.log(
    `Site-level issue detection: ${issues.length} issues found for project ${projectId}`,
  );
  return issues.length;
}
