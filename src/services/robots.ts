import axios from "axios";
import robotsParser from "robots-parser";

import { supabase } from "../db/supabase";
import { Project } from "../types";

import logger from "../utils/logger";

export async function fetchAndParseRobotsTxt(project: Project): Promise<any> {
  try {
    // Extract domain from project URL
    const projectUrl = new URL(project.url);
    const robotsTxtUrl = `${projectUrl.protocol}//${projectUrl.hostname}/robots.txt`;

    // Fetch robots.txt
    const response = await axios.get(robotsTxtUrl, {
      timeout: 5000,
      headers: {
        "User-Agent": "RankRiot Crawler/1.0 (+https://rankriot.app/bot)",
      },
    });

    if (response.status !== 200) {
      logger.info(
        `No robots.txt found at ${robotsTxtUrl} (Status: ${response.status})`,
      );
      return null;
    }

    // Parse robots.txt - correct usage with two arguments
    const robotsTxt = robotsParser(robotsTxtUrl, response.data);

    // Get sitemaps (this method exists in robots-parser)
    const sitemaps = robotsTxt.getSitemaps() || [];

    // Since robots-parser doesn't expose userAgents directly,
    // we'll create our own structure based on what we need
    const parsedRules = {
      userAgents: [
        {
          name: "RankRiot",
          rules: {
            allow: [], // We'll populate these from the isAllowed checks
            disallow: [], // We'll populate these from the isDisallowed checks
            crawlDelay: robotsTxt.getCrawlDelay("RankRiot"),
          },
        },
        {
          name: "*",
          rules: {
            allow: [],
            disallow: [],
            crawlDelay: robotsTxt.getCrawlDelay("*"),
          },
        },
      ],
      sitemaps: sitemaps,
    };

    // Save to database
    await updateProjectRobotsTxt(project.id, parsedRules);

    return parsedRules;
  } catch (error) {
    if (error instanceof Error) {
      logger.error(`Error fetching robots.txt: ${error.message}`);
    } else {
      logger.error(`Unknown error fetching robots.txt`);
    }
    return null;
  }
}

export async function isAllowedByRobotsTxt(
  project: Project,
  url: string,
): Promise<undefined | boolean> {
  try {
    // If no robots.txt data exists, fetch it
    if (!project.robots_txt) {
      await fetchAndParseRobotsTxt(project);

      // Refresh project data
      const { data: refreshedProject } = await supabase
        .from("projects")
        .select("*")
        .eq("id", project.id)
        .single();

      if (!refreshedProject || !refreshedProject.robots_txt) {
        // If still no robots.txt, assume allowed
        return true;
      }

      project = refreshedProject;
    }

    // If we have robots.txt from the project, recreate the parser to use isAllowed
    const projectUrl = new URL(project.url);
    const robotsTxtUrl = `${projectUrl.protocol}//${projectUrl.hostname}/robots.txt`;

    // Reconstruct the robots.txt content from our stored data
    // This is just a placeholder - in practice we should fetch the content again
    // or store the raw content in addition to our parsed structure
    try {
      // Try to fetch the robots.txt again to use with the parser
      const response = await axios.get(robotsTxtUrl, {
        timeout: 3000,
        headers: {
          "User-Agent": "RankRiot Crawler/1.0 (+https://rankriot.app/bot)",
        },
      });

      if (response.status === 200) {
        const robotsTxt = robotsParser(robotsTxtUrl, response.data);
        // Check if our user agent is allowed
        return robotsTxt.isAllowed(url, "RankRiot");
      }
    } catch (err) {
      // If we can't fetch it again, fall back to our simple check
      logger.warn(`Couldn't re-fetch robots.txt, using fallback checks`);
    }

    // Fallback: Simple path-based check using our stored data
    const robotsTxtData = project.robots_txt as any;

    // Check for our user agent first, then fall back to wildcard
    const ourAgent = robotsTxtData.userAgents.find(
      (ua: any) => ua.name === "RankRiot",
    );
    const wildcardAgent = robotsTxtData.userAgents.find(
      (ua: any) => ua.name === "*",
    );

    const rules = ourAgent || wildcardAgent;

    // If no agent rules found, assume allowed
    if (!rules) return true;

    // Simple path matching
    const urlPath = new URL(url).pathname;

    // Check if any disallow rule matches
    for (const disallowPath of rules.rules.disallow) {
      if (urlPath.startsWith(disallowPath)) {
        return false;
      }
    }

    // Allow by default
    return true;
  } catch (error) {
    // On error, allow crawling
    logger.error(`Error checking robots.txt permissions: ${error}`);
    return true;
  }
}

async function updateProjectRobotsTxt(
  projectId: string,
  robotsTxt: any,
): Promise<void> {
  try {
    await supabase
      .from("projects")
      .update({ robots_txt: robotsTxt })
      .eq("id", projectId);

    logger.info(`Updated robots.txt for project ${projectId}`);
  } catch (error) {
    logger.error(`Error updating robots.txt in database: ${error}`);
  }
}
