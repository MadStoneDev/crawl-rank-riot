"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCrawl = startCrawl;
const axios_1 = __importDefault(require("axios"));
const cheerio_1 = __importDefault(require("cheerio"));
const uuid_1 = require("uuid");
const puppeteer_core_1 = __importDefault(require("puppeteer-core"));
const config_1 = __importDefault(require("../config"));
const queue_1 = __importDefault(require("./queue"));
const logger_1 = __importDefault(require("../utils/logger"));
const robots_1 = require("./robots");
const supabase_1 = require("../db/supabase");
// Create a singleton queue for all crawls
const crawlQueue = new queue_1.default(config_1.default.crawler.concurrency);
// Start the crawl process
async function startCrawl(scan) {
    var _a;
    try {
        const project = scan.projects;
        if (!project) {
            throw new Error("Project data not found in scan");
        }
        logger_1.default.info(`Starting crawl for ${project.url}`);
        // Clear any existing queue
        crawlQueue.clear();
        // Fetch and parse robots.txt
        await (0, robots_1.fetchAndParseRobotsTxt)(project);
        // Get or refresh project with robots.txt data
        const { data: refreshedProject } = await supabase_1.supabase
            .from("projects")
            .select("*")
            .eq("id", project.id)
            .single();
        if (!refreshedProject) {
            throw new Error(`Could not refresh project data for ${project.id}`);
        }
        // Initialize counters
        let pagesScanned = 0;
        let linksScanned = 0;
        let issuesFound = 0;
        // Extract base URL for comparison
        const baseUrl = new URL(project.url);
        const baseHostname = baseUrl.hostname;
        // Maximum pages to scan (can be overridden in project settings)
        const maxPages = ((_a = project.settings) === null || _a === void 0 ? void 0 : _a.max_pages) || config_1.default.crawler.maxPages;
        // Add the seed URL to the queue
        await crawlQueue.add({
            url: project.url,
            depth: 0,
            priority: 100, // Highest priority for seed URL
        }, async (item) => {
            // Check if we've reached the page limit
            if (pagesScanned >= maxPages) {
                crawlQueue.pause();
                return;
            }
            // Check robots.txt
            if (config_1.default.crawler.respectRobotsTxt &&
                !(await (0, robots_1.isAllowedByRobotsTxt)(refreshedProject, item.url))) {
                logger_1.default.info(`Skipping ${item.url} - disallowed by robots.txt`);
                return;
            }
            // Crawl the page
            const pageData = await crawlPage(item.url, item.depth, item.referrer);
            // Process the crawled page
            if (pageData) {
                // Save page to database
                const pageId = await savePage(pageData, project.id, scan.id);
                // Increment counters
                pagesScanned++;
                linksScanned += pageData.links.length;
                issuesFound += pageData.issues.length;
                // Update scan progress
                await updateScanProgress(scan.id, pagesScanned, linksScanned, issuesFound);
                // Process links for further crawling
                for (const link of pageData.links) {
                    try {
                        // Only queue internal links
                        if (link.link_type === "internal") {
                            const linkUrl = new URL(link.destination_url);
                            // Check if it's the same domain
                            if (linkUrl.hostname === baseHostname) {
                                // Add to queue with diminishing priority by depth
                                await crawlQueue.add({
                                    url: link.destination_url,
                                    depth: item.depth + 1,
                                    referrer: item.url,
                                    priority: Math.max(0, 100 - (item.depth + 1) * 10), // Priority decreases with depth
                                }, async (item) => {
                                    // This will recursively call the same function
                                });
                            }
                        }
                    }
                    catch (error) {
                        logger_1.default.error(`Error processing link ${link.destination_url}: ${error}`);
                    }
                }
            }
        });
        // Wait for the queue to complete
        while (crawlQueue.size > 0 || crawlQueue.pending > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        logger_1.default.info(`Crawl completed for ${project.url}. Pages: ${pagesScanned}, Links: ${linksScanned}, Issues: ${issuesFound}`);
    }
    catch (error) {
        if (error instanceof Error) {
            throw new Error(`Crawl error: ${error.message}`);
        }
        throw new Error("Unknown crawl error");
    }
}
// Crawl a single page
async function crawlPage(url, depth, referrer) {
    var _a, _b, _c;
    logger_1.default.info(`Crawling ${url} (depth: ${depth})`);
    const startTime = Date.now();
    let pageData = null;
    try {
        // First try with simple HTTP request (faster)
        pageData = await crawlWithHttp(url, depth);
        // If page is likely JavaScript-heavy, retry with puppeteer
        if (pageData && (pageData.js_count || 0) > 5) {
            pageData = await crawlWithPuppeteer(url, depth);
        }
        const endTime = Date.now();
        if (pageData) {
            pageData.load_time_ms = endTime - startTime;
        }
        return pageData;
    }
    catch (error) {
        logger_1.default.error(`Error crawling ${url}: ${error}`);
        // Return a minimal error page data
        return {
            url,
            title: null,
            h1s: null,
            h2s: null,
            h3s: null,
            meta_description: null,
            canonical_url: null,
            http_status: error instanceof axios_1.default.AxiosError
                ? ((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) || null
                : null,
            content_type: null,
            content_length: null,
            is_indexable: false,
            has_robots_noindex: false,
            has_robots_nofollow: false,
            redirect_url: error instanceof axios_1.default.AxiosError
                ? ((_c = (_b = error.response) === null || _b === void 0 ? void 0 : _b.headers) === null || _c === void 0 ? void 0 : _c.location) || null
                : null,
            load_time_ms: Date.now() - startTime,
            first_byte_time_ms: null,
            size_bytes: null,
            image_count: null,
            js_count: null,
            css_count: null,
            open_graph: null,
            twitter_card: null,
            structured_data: null,
            links: [],
            issues: [
                {
                    issue_type: "error",
                    description: `Failed to crawl: ${error instanceof Error ? error.message : "Unknown error"}`,
                    severity: "high",
                },
            ],
        };
    }
}
// Crawl a page using HTTP request
async function crawlWithHttp(url, depth) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    // Track timing
    const startTime = Date.now();
    // Make the request
    const response = await axios_1.default.get(url, {
        headers: {
            "User-Agent": "RankRiot Crawler/1.0 (+https://rankriot.app/bot)",
        },
        timeout: config_1.default.crawler.timeout,
        validateStatus: () => true, // Accept all status codes
        maxRedirects: 5,
    });
    const firstByteTime = Date.now() - startTime;
    // Handle non-HTML content
    const contentType = response.headers["content-type"] || "";
    if (!contentType.includes("text/html")) {
        return {
            url,
            title: null,
            h1s: null,
            h2s: null,
            h3s: null,
            meta_description: null,
            canonical_url: null,
            http_status: response.status,
            content_type: contentType,
            content_length: parseInt(response.headers["content-length"] || "0", 10) || null,
            is_indexable: false,
            has_robots_noindex: false,
            has_robots_nofollow: false,
            redirect_url: ((_b = (_a = response.request) === null || _a === void 0 ? void 0 : _a.res) === null || _b === void 0 ? void 0 : _b.responseUrl) !== url
                ? (_d = (_c = response.request) === null || _c === void 0 ? void 0 : _c.res) === null || _d === void 0 ? void 0 : _d.responseUrl
                : null,
            load_time_ms: null, // Set later
            first_byte_time_ms: firstByteTime,
            size_bytes: ((_e = response.data) === null || _e === void 0 ? void 0 : _e.length) || null,
            image_count: 0,
            js_count: 0,
            css_count: 0,
            open_graph: null,
            twitter_card: null,
            structured_data: null,
            links: [],
            issues: [
                {
                    issue_type: "non_html_content",
                    description: `Page is not HTML (${contentType})`,
                    severity: "medium",
                },
            ],
        };
    }
    // Parse with cheerio
    const $ = cheerio_1.default.load(response.data);
    // Extract page data
    const title = $("title").text().trim();
    const h1s = $("h1")
        .map((i, el) => $(el).text().trim())
        .get();
    const h2s = $("h2")
        .map((i, el) => $(el).text().trim())
        .get();
    const h3s = $("h3")
        .map((i, el) => $(el).text().trim())
        .get();
    const metaDescription = $('meta[name="description"]').attr("content") || null;
    const canonicalUrl = $('link[rel="canonical"]').attr("href") || null;
    const hasRobotsNoindex = ((_f = $('meta[name="robots"]').attr("content")) === null || _f === void 0 ? void 0 : _f.includes("noindex")) || false;
    const hasRobotsNofollow = ((_g = $('meta[name="robots"]').attr("content")) === null || _g === void 0 ? void 0 : _g.includes("nofollow")) || false;
    // Count resources
    const images = $("img").length;
    const scripts = $("script").length;
    const stylesheets = $('link[rel="stylesheet"]').length;
    // Extract links
    const links = [];
    $("a[href]").each((i, el) => {
        var _a;
        const href = $(el).attr("href");
        if (!href)
            return;
        try {
            // Resolve relative URLs
            const resolvedUrl = new URL(href, url).href;
            const isInternal = new URL(resolvedUrl).hostname === new URL(url).hostname;
            links.push({
                destination_url: resolvedUrl,
                anchor_text: $(el).text().trim() || null,
                link_type: isInternal ? "internal" : "external",
                is_followed: !((_a = $(el).attr("rel")) === null || _a === void 0 ? void 0 : _a.includes("nofollow")),
            });
        }
        catch (error) {
            // Skip invalid URLs
        }
    });
    // Continuing the crawlWithHttp function
    // Extract resources like images, scripts, and stylesheets
    $("link[href], script[src], img[src]").each((i, el) => {
        const src = $(el).attr("src") || $(el).attr("href");
        if (!src)
            return;
        try {
            // Resolve relative URLs
            const resolvedUrl = new URL(src, url).href;
            links.push({
                destination_url: resolvedUrl,
                anchor_text: null,
                link_type: "resource",
                is_followed: true,
            });
        }
        catch (error) {
            // Skip invalid URLs
        }
    });
    // Extract Open Graph data
    const openGraph = {};
    $('meta[property^="og:"]').each((i, el) => {
        var _a;
        const property = (_a = $(el).attr("property")) === null || _a === void 0 ? void 0 : _a.replace("og:", "");
        const content = $(el).attr("content");
        if (property && content) {
            openGraph[property] = content;
        }
    });
    // Extract Twitter Card data
    const twitterCard = {};
    $('meta[name^="twitter:"]').each((i, el) => {
        var _a;
        const name = (_a = $(el).attr("name")) === null || _a === void 0 ? void 0 : _a.replace("twitter:", "");
        const content = $(el).attr("content");
        if (name && content) {
            twitterCard[name] = content;
        }
    });
    // Look for structured data
    const structuredData = [];
    $('script[type="application/ld+json"]').each((i, el) => {
        try {
            const json = JSON.parse($(el).html() || "{}");
            structuredData.push(json);
        }
        catch (error) {
            // Skip invalid JSON
        }
    });
    // Find issues
    const issues = [];
    // Check for missing title
    if (!title) {
        issues.push({
            issue_type: "missing_title",
            description: "Page is missing a title tag",
            severity: "high",
        });
    }
    else if (title.length < 10 || title.length > 70) {
        issues.push({
            issue_type: "title_length",
            description: `Title length (${title.length} chars) is ${title.length < 10 ? "too short" : "too long"}`,
            severity: "medium",
        });
    }
    // Check for missing meta description
    if (!metaDescription) {
        issues.push({
            issue_type: "missing_meta_description",
            description: "Page is missing a meta description",
            severity: "medium",
        });
    }
    else if (metaDescription.length < 50 || metaDescription.length > 160) {
        issues.push({
            issue_type: "meta_description_length",
            description: `Meta description length (${metaDescription.length} chars) is ${metaDescription.length < 50 ? "too short" : "too long"}`,
            severity: "low",
        });
    }
    // Check for missing H1
    if (h1s.length === 0) {
        issues.push({
            issue_type: "missing_h1",
            description: "Page is missing an H1 tag",
            severity: "medium",
        });
    }
    else if (h1s.length > 1) {
        issues.push({
            issue_type: "multiple_h1",
            description: `Page has ${h1s.length} H1 tags, should have only one`,
            severity: "medium",
        });
    }
    // Check for broken link issues (will be updated later when links are checked)
    return {
        url,
        title: title || null,
        h1s: h1s.length > 0 ? h1s : null,
        h2s: h2s.length > 0 ? h2s : null,
        h3s: h3s.length > 0 ? h3s : null,
        meta_description: metaDescription,
        canonical_url: canonicalUrl,
        http_status: response.status,
        content_type: contentType,
        content_length: response.data.length,
        is_indexable: !hasRobotsNoindex,
        has_robots_noindex: hasRobotsNoindex,
        has_robots_nofollow: hasRobotsNofollow,
        redirect_url: ((_j = (_h = response.request) === null || _h === void 0 ? void 0 : _h.res) === null || _j === void 0 ? void 0 : _j.responseUrl) !== url
            ? (_l = (_k = response.request) === null || _k === void 0 ? void 0 : _k.res) === null || _l === void 0 ? void 0 : _l.responseUrl
            : null,
        load_time_ms: null, // Set later
        first_byte_time_ms: firstByteTime,
        size_bytes: response.data.length,
        image_count: images,
        js_count: scripts,
        css_count: stylesheets,
        open_graph: Object.keys(openGraph).length > 0 ? openGraph : null,
        twitter_card: Object.keys(twitterCard).length > 0 ? twitterCard : null,
        structured_data: structuredData.length > 0 ? structuredData : null,
        links,
        issues,
    };
}
// Crawl a page using Puppeteer (for JavaScript-heavy pages)
async function crawlWithPuppeteer(url, depth) {
    var _a;
    logger_1.default.info(`Using Puppeteer for JavaScript-heavy page: ${url}`);
    // Track timing
    const startTime = Date.now();
    // Launch browser
    const browser = await puppeteer_core_1.default.launch({
        executablePath: process.env.CHROME_BIN || "/usr/bin/chromium-browser",
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
        ],
    });
    try {
        const page = await browser.newPage();
        // Set user agent
        await page.setUserAgent("RankRiot Crawler/1.0 (+https://rankriot.app/bot)");
        // Set viewport
        await page.setViewport({ width: 1280, height: 800 });
        // Set timeout - ensure it has a default value
        page.setDefaultNavigationTimeout(config_1.default.crawler.timeout || 30000);
        // Track performance
        let firstByteTime = 0;
        page.on("response", (response) => {
            if (response.url() === url) {
                firstByteTime = Date.now() - startTime;
            }
        });
        // Navigate to page
        const response = await page.goto(url, { waitUntil: "networkidle2" });
        if (!response) {
            throw new Error("No response received");
        }
        // Wait a bit for any remaining JavaScript to execute
        await new Promise((resolve) => setTimeout(resolve, 1000));
        // Get content type
        const contentType = response.headers()["content-type"] || "";
        // Handle non-HTML content
        if (!contentType.includes("text/html")) {
            await browser.close();
            return {
                url,
                title: null,
                h1s: null,
                h2s: null,
                h3s: null,
                meta_description: null,
                canonical_url: null,
                http_status: response.status(),
                content_type: contentType,
                content_length: parseInt(response.headers()["content-length"] || "0", 10) || null,
                is_indexable: false,
                has_robots_noindex: false,
                has_robots_nofollow: false,
                redirect_url: response.url() !== url ? response.url() : null,
                load_time_ms: null, // Set later
                first_byte_time_ms: firstByteTime,
                size_bytes: null,
                image_count: 0,
                js_count: 0,
                css_count: 0,
                open_graph: null,
                twitter_card: null,
                structured_data: null,
                links: [],
                issues: [
                    {
                        issue_type: "non_html_content",
                        description: `Page is not HTML (${contentType})`,
                        severity: "medium",
                    },
                ],
            };
        }
        // Extract page data using page.evaluate
        const pageData = await page.evaluate(() => {
            var _a, _b, _c;
            // Helper to get all text content from elements
            const getTextContent = (selector) => {
                return Array.from(document.querySelectorAll(selector))
                    .map((el) => { var _a; return ((_a = el.textContent) === null || _a === void 0 ? void 0 : _a.trim()) || ""; })
                    .filter((text) => text.length > 0);
            };
            // Extract basic page data
            const title = document.title;
            const h1s = getTextContent("h1");
            const h2s = getTextContent("h2");
            const h3s = getTextContent("h3");
            // Extract meta description
            const metaDescription = ((_a = document
                .querySelector('meta[name="description"]')) === null || _a === void 0 ? void 0 : _a.getAttribute("content")) || null;
            // Extract canonical URL
            const canonicalUrl = ((_b = document.querySelector('link[rel="canonical"]')) === null || _b === void 0 ? void 0 : _b.getAttribute("href")) ||
                null;
            // Check for robots meta tags
            const robotsMeta = ((_c = document
                .querySelector('meta[name="robots"]')) === null || _c === void 0 ? void 0 : _c.getAttribute("content")) || "";
            const hasRobotsNoindex = robotsMeta.includes("noindex");
            const hasRobotsNofollow = robotsMeta.includes("nofollow");
            // Count resources
            const images = document.querySelectorAll("img").length;
            const scripts = document.querySelectorAll("script").length;
            const stylesheets = document.querySelectorAll('link[rel="stylesheet"]').length;
            // Extract all links
            const links = Array.from(document.querySelectorAll("a[href]")).map((el) => {
                var _a;
                const anchor = el;
                return {
                    href: anchor.href,
                    text: ((_a = anchor.textContent) === null || _a === void 0 ? void 0 : _a.trim()) || null,
                    rel: anchor.getAttribute("rel") || null,
                };
            });
            // Extract resource links
            const resourceLinks = Array.from(document.querySelectorAll("link[href], script[src], img[src]"))
                .map((el) => {
                if (el instanceof HTMLLinkElement) {
                    return { href: el.href, type: "link" };
                }
                else if (el instanceof HTMLScriptElement) {
                    return { href: el.src, type: "script" };
                }
                else if (el instanceof HTMLImageElement) {
                    return { href: el.src, type: "img" };
                }
                return null;
            })
                .filter(Boolean);
            // Extract Open Graph data
            const openGraph = {};
            document.querySelectorAll('meta[property^="og:"]').forEach((el) => {
                var _a;
                const property = (_a = el.getAttribute("property")) === null || _a === void 0 ? void 0 : _a.replace("og:", "");
                const content = el.getAttribute("content");
                if (property && content) {
                    openGraph[property] = content;
                }
            });
            // Extract Twitter Card data
            const twitterCard = {};
            document.querySelectorAll('meta[name^="twitter:"]').forEach((el) => {
                var _a;
                const name = (_a = el.getAttribute("name")) === null || _a === void 0 ? void 0 : _a.replace("twitter:", "");
                const content = el.getAttribute("content");
                if (name && content) {
                    twitterCard[name] = content;
                }
            });
            // Look for structured data
            const structuredData = [];
            document
                .querySelectorAll('script[type="application/ld+json"]')
                .forEach((el) => {
                try {
                    const json = JSON.parse(el.textContent || "{}");
                    structuredData.push(json);
                }
                catch (error) {
                    // Skip invalid JSON
                }
            });
            return {
                title,
                h1s,
                h2s,
                h3s,
                metaDescription,
                canonicalUrl,
                hasRobotsNoindex,
                hasRobotsNofollow,
                images,
                scripts,
                stylesheets,
                links,
                resourceLinks,
                openGraph,
                twitterCard,
                structuredData,
            };
        });
        // Process links from the page
        const processedLinks = [];
        // Process regular links
        for (const link of pageData.links || []) {
            try {
                const isInternal = new URL(link.href).hostname === new URL(url).hostname;
                processedLinks.push({
                    destination_url: link.href,
                    anchor_text: link.text,
                    link_type: isInternal ? "internal" : "external",
                    is_followed: !((_a = link.rel) === null || _a === void 0 ? void 0 : _a.includes("nofollow")),
                });
            }
            catch (error) {
                // Skip invalid URLs
            }
        }
        // Process resource links
        // Process resource links
        for (const resource of pageData.resourceLinks || []) {
            try {
                if (resource && resource.href) {
                    // Add null check
                    processedLinks.push({
                        destination_url: resource.href,
                        anchor_text: null,
                        link_type: "resource",
                        is_followed: true,
                    });
                }
            }
            catch (error) {
                // Skip invalid URLs
            }
        }
        // Find issues
        const issues = [];
        // Check for missing title
        if (!pageData.title) {
            issues.push({
                issue_type: "missing_title",
                description: "Page is missing a title tag",
                severity: "high",
            });
        }
        else if (pageData.title.length < 10 || pageData.title.length > 70) {
            issues.push({
                issue_type: "title_length",
                description: `Title length (${pageData.title.length} chars) is ${pageData.title.length < 10 ? "too short" : "too long"}`,
                severity: "medium",
            });
        }
        // Check for missing meta description
        if (!pageData.metaDescription) {
            issues.push({
                issue_type: "missing_meta_description",
                description: "Page is missing a meta description",
                severity: "medium",
            });
        }
        else if (pageData.metaDescription.length < 50 ||
            pageData.metaDescription.length > 160) {
            issues.push({
                issue_type: "meta_description_length",
                description: `Meta description length (${pageData.metaDescription.length} chars) is ${pageData.metaDescription.length < 50 ? "too short" : "too long"}`,
                severity: "low",
            });
        }
        // Check for missing H1
        if (pageData.h1s.length === 0) {
            issues.push({
                issue_type: "missing_h1",
                description: "Page is missing an H1 tag",
                severity: "medium",
            });
        }
        else if (pageData.h1s.length > 1) {
            issues.push({
                issue_type: "multiple_h1",
                description: `Page has ${pageData.h1s.length} H1 tags, should have only one`,
                severity: "medium",
            });
        }
        // Close browser
        await browser.close();
        return {
            url,
            title: pageData.title || null,
            h1s: pageData.h1s.length > 0 ? pageData.h1s : null,
            h2s: pageData.h2s.length > 0 ? pageData.h2s : null,
            h3s: pageData.h3s.length > 0 ? pageData.h3s : null,
            meta_description: pageData.metaDescription,
            canonical_url: pageData.canonicalUrl,
            http_status: response.status(),
            content_type: contentType,
            content_length: null, // Hard to determine accurately with Puppeteer
            is_indexable: !pageData.hasRobotsNoindex,
            has_robots_noindex: pageData.hasRobotsNoindex,
            has_robots_nofollow: pageData.hasRobotsNofollow,
            redirect_url: response.url() !== url ? response.url() : null,
            load_time_ms: null, // Set later
            first_byte_time_ms: firstByteTime,
            size_bytes: null, // Hard to determine accurately with Puppeteer
            image_count: pageData.images,
            js_count: pageData.scripts,
            css_count: pageData.stylesheets,
            open_graph: Object.keys(pageData.openGraph).length > 0 ? pageData.openGraph : null,
            twitter_card: Object.keys(pageData.twitterCard).length > 0
                ? pageData.twitterCard
                : null,
            structured_data: pageData.structuredData.length > 0 ? pageData.structuredData : null,
            links: processedLinks,
            issues,
        };
    }
    catch (error) {
        // Close browser on error
        await browser.close();
        throw error;
    }
}
// Save page data to database
async function savePage(pageData, projectId, scanId) {
    const pageId = (0, uuid_1.v4)();
    try {
        // Check if the page already exists
        const { data: existingPage } = await supabase_1.supabase
            .from("pages")
            .select("id")
            .eq("project_id", projectId)
            .eq("url", pageData.url)
            .single();
        // Prepare the page data
        const page = {
            id: (existingPage === null || existingPage === void 0 ? void 0 : existingPage.id) || pageId,
            project_id: projectId,
            url: pageData.url,
            title: pageData.title,
            h1s: pageData.h1s,
            h2s: pageData.h2s,
            h3s: pageData.h3s,
            meta_description: pageData.meta_description,
            canonical_url: pageData.canonical_url,
            http_status: pageData.http_status,
            content_type: pageData.content_type,
            content_length: pageData.content_length,
            is_indexable: pageData.is_indexable,
            has_robots_noindex: pageData.has_robots_noindex,
            has_robots_nofollow: pageData.has_robots_nofollow,
            redirect_url: pageData.redirect_url,
            load_time_ms: pageData.load_time_ms,
            first_byte_time_ms: pageData.first_byte_time_ms,
            size_bytes: pageData.size_bytes,
            image_count: pageData.image_count,
            js_count: pageData.js_count,
            css_count: pageData.css_count,
            open_graph: pageData.open_graph,
            twitter_card: pageData.twitter_card,
            structured_data: pageData.structured_data,
        };
        if (existingPage) {
            // Update existing page
            await supabase_1.supabase.from("pages").update(page).eq("id", existingPage.id);
        }
        else {
            // Insert new page
            await supabase_1.supabase.from("pages").insert(page);
        }
        // Save the scan snapshot
        await saveScanSnapshot((existingPage === null || existingPage === void 0 ? void 0 : existingPage.id) || pageId, scanId, pageData);
        // Save links
        await saveLinks((existingPage === null || existingPage === void 0 ? void 0 : existingPage.id) || pageId, projectId, pageData.links);
        // Save issues
        await saveIssues((existingPage === null || existingPage === void 0 ? void 0 : existingPage.id) || pageId, projectId, scanId, pageData.issues);
        return (existingPage === null || existingPage === void 0 ? void 0 : existingPage.id) || pageId;
    }
    catch (error) {
        logger_1.default.error(`Error saving page ${pageData.url}: ${error}`);
        throw error;
    }
}
// Save scan snapshot
async function saveScanSnapshot(pageId, scanId, pageData) {
    try {
        const snapshot = {
            id: (0, uuid_1.v4)(),
            scan_id: scanId,
            page_id: pageId,
            url: pageData.url,
            title: pageData.title,
            h1s: pageData.h1s,
            h2s: pageData.h2s,
            h3s: pageData.h3s,
            meta_description: pageData.meta_description,
            http_status: pageData.http_status,
            is_indexable: pageData.is_indexable,
            content_length: pageData.content_length,
            snapshot_data: {
                canonical_url: pageData.canonical_url,
                has_robots_noindex: pageData.has_robots_noindex,
                has_robots_nofollow: pageData.has_robots_nofollow,
                redirect_url: pageData.redirect_url,
                load_time_ms: pageData.load_time_ms,
                first_byte_time_ms: pageData.first_byte_time_ms,
                size_bytes: pageData.size_bytes,
                image_count: pageData.image_count,
                js_count: pageData.js_count,
                css_count: pageData.css_count,
                open_graph: pageData.open_graph,
                twitter_card: pageData.twitter_card,
                structured_data: pageData.structured_data,
            },
            // Convert the issues array to JSON
            issues: pageData.issues,
        };
        await supabase_1.supabase.from("scan_page_snapshots").insert(snapshot);
    }
    catch (error) {
        logger_1.default.error(`Error saving scan snapshot for page ${pageId}: ${error}`);
    }
}
// Save links
async function saveLinks(pageId, projectId, links) {
    try {
        // Filter out any empty or invalid links
        const validLinks = links.filter((link) => link.destination_url);
        if (validLinks.length === 0) {
            return;
        }
        // Insert all links
        const linkRecords = validLinks.map((link) => ({
            id: (0, uuid_1.v4)(),
            project_id: projectId,
            source_page_id: pageId,
            destination_url: link.destination_url,
            anchor_text: link.anchor_text,
            link_type: link.link_type,
            is_followed: link.is_followed,
            // These will be updated later in a separate process
            is_broken: null,
            http_status: null,
            destination_page_id: null,
        }));
        await supabase_1.supabase.from("page_links").upsert(linkRecords, {
            onConflict: "source_page_id,destination_url",
            ignoreDuplicates: false,
        });
    }
    catch (error) {
        logger_1.default.error(`Error saving links for page ${pageId}: ${error}`);
    }
}
// Save issues
async function saveIssues(pageId, projectId, scanId, issues) {
    try {
        if (issues.length === 0) {
            return;
        }
        const issueRecords = issues.map((issue) => ({
            id: (0, uuid_1.v4)(),
            project_id: projectId,
            scan_id: scanId,
            page_id: pageId,
            issue_type: issue.issue_type,
            description: issue.description,
            severity: issue.severity,
            is_fixed: false,
            details: issue.details || null,
        }));
        await supabase_1.supabase.from("issues").insert(issueRecords);
    }
    catch (error) {
        logger_1.default.error(`Error saving issues for page ${pageId}: ${error}`);
    }
}
// Update scan progress
async function updateScanProgress(scanId, pagesScanned, linksScanned, issuesFound) {
    try {
        await supabase_1.supabase
            .from("scans")
            .update({
            pages_scanned: pagesScanned,
            links_scanned: linksScanned,
            issues_found: issuesFound,
            updated_at: new Date().toISOString(),
        })
            .eq("id", scanId);
    }
    catch (error) {
        logger_1.default.error(`Error updating scan progress for ${scanId}: ${error}`);
    }
}
