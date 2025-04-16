"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchAndParseRobotsTxt = fetchAndParseRobotsTxt;
exports.isAllowedByRobotsTxt = isAllowedByRobotsTxt;
const axios_1 = __importDefault(require("axios"));
const robots_parser_1 = __importDefault(require("robots-parser"));
const supabase_1 = require("../db/supabase");
const logger_1 = __importDefault(require("../utils/logger"));
async function fetchAndParseRobotsTxt(project) {
    try {
        // Extract domain from project URL
        const projectUrl = new URL(project.url);
        const robotsTxtUrl = `${projectUrl.protocol}//${projectUrl.hostname}/robots.txt`;
        // Fetch robots.txt
        const response = await axios_1.default.get(robotsTxtUrl, {
            timeout: 5000,
            headers: {
                "User-Agent": "RankRiot Crawler/1.0 (+https://rankriot.app/bot)",
            },
        });
        if (response.status !== 200) {
            logger_1.default.info(`No robots.txt found at ${robotsTxtUrl} (Status: ${response.status})`);
            return null;
        }
        // Parse robots.txt - correct usage with two arguments
        const robotsTxt = (0, robots_parser_1.default)(robotsTxtUrl, response.data);
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
    }
    catch (error) {
        if (error instanceof Error) {
            logger_1.default.error(`Error fetching robots.txt: ${error.message}`);
        }
        else {
            logger_1.default.error(`Unknown error fetching robots.txt`);
        }
        return null;
    }
}
async function isAllowedByRobotsTxt(project, url) {
    try {
        // If no robots.txt data exists, fetch it
        if (!project.robots_txt) {
            await fetchAndParseRobotsTxt(project);
            // Refresh project data
            const { data: refreshedProject } = await supabase_1.supabase
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
            const response = await axios_1.default.get(robotsTxtUrl, {
                timeout: 3000,
                headers: {
                    "User-Agent": "RankRiot Crawler/1.0 (+https://rankriot.app/bot)",
                },
            });
            if (response.status === 200) {
                const robotsTxt = (0, robots_parser_1.default)(robotsTxtUrl, response.data);
                // Check if our user agent is allowed
                return robotsTxt.isAllowed(url, "RankRiot");
            }
        }
        catch (err) {
            // If we can't fetch it again, fall back to our simple check
            logger_1.default.warn(`Couldn't re-fetch robots.txt, using fallback checks`);
        }
        // Fallback: Simple path-based check using our stored data
        const robotsTxtData = project.robots_txt;
        // Check for our user agent first, then fall back to wildcard
        const ourAgent = robotsTxtData.userAgents.find((ua) => ua.name === "RankRiot");
        const wildcardAgent = robotsTxtData.userAgents.find((ua) => ua.name === "*");
        const rules = ourAgent || wildcardAgent;
        // If no agent rules found, assume allowed
        if (!rules)
            return true;
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
    }
    catch (error) {
        // On error, allow crawling
        logger_1.default.error(`Error checking robots.txt permissions: ${error}`);
        return true;
    }
}
async function updateProjectRobotsTxt(projectId, robotsTxt) {
    try {
        await supabase_1.supabase
            .from("projects")
            .update({ robots_txt: robotsTxt })
            .eq("id", projectId);
        logger_1.default.info(`Updated robots.txt for project ${projectId}`);
    }
    catch (error) {
        logger_1.default.error(`Error updating robots.txt in database: ${error}`);
    }
}
