"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueScan = queueScan;
exports.startScan = startScan;
exports.getScanStatus = getScanStatus;
exports.initScheduler = initScheduler;
const cron = __importStar(require("node-cron"));
const uuid_1 = require("uuid");
const supabase_1 = require("../db/supabase");
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
const crawler = __importStar(require("./crawler"));
const notifications_1 = require("./notifications");
// Map to track active scans
const activeScans = new Map();
// Queue a new scan
async function queueScan(projectId) {
    try {
        // Get the project
        const { data: project, error: projectError } = await supabase_1.supabase
            .from("projects")
            .select("*")
            .eq("id", projectId)
            .single();
        if (projectError || !project) {
            throw new Error(`Project not found: ${projectId}`);
        }
        // Check for ongoing scans
        const { data: ongoingScans, error: scanError } = await supabase_1.supabase
            .from("scans")
            .select("id")
            .eq("project_id", projectId)
            .in("status", ["queued", "in_progress"])
            .order("created_at", { ascending: true });
        if (scanError) {
            throw new Error(`Error checking for ongoing scans: ${scanError.message}`);
        }
        // Count the queue
        const { count, error: countError } = await supabase_1.supabase
            .from("scans")
            .select("*", { count: "exact", head: true })
            .eq("status", "queued");
        if (countError) {
            throw new Error(`Error getting queue count: ${countError.message}`);
        }
        // Create a new scan
        const scanId = (0, uuid_1.v4)();
        const queue_position = (ongoingScans === null || ongoingScans === void 0 ? void 0 : ongoingScans.length)
            ? ongoingScans.length
            : count || 0;
        const newScan = {
            id: scanId,
            project_id: projectId,
            status: "queued",
            queue_position,
        };
        const { data: scan, error: insertError } = await supabase_1.supabase
            .from("scans")
            .insert(newScan)
            .select()
            .single();
        if (insertError || !scan) {
            throw new Error(`Error creating scan: ${insertError === null || insertError === void 0 ? void 0 : insertError.message}`);
        }
        logger_1.default.info(`Queued new scan ${scanId} for project ${projectId}`);
        // If no ongoing scans, start this one immediately
        if ((ongoingScans === null || ongoingScans === void 0 ? void 0 : ongoingScans.length) === 0) {
            // Start scan process in the background
            startScan(scanId).catch((err) => {
                logger_1.default.error(`Error in background scan process: ${err}`);
            });
        }
        return scan;
    }
    catch (error) {
        if (error instanceof Error) {
            throw error;
        }
        throw new Error("Unknown error queueing scan");
    }
}
// Start a scan
async function startScan(scanId) {
    // If scan is already running, ignore
    if (activeScans.has(scanId)) {
        return;
    }
    try {
        // Mark scan as active
        activeScans.set(scanId, true);
        // Get the scan
        const { data: scan, error: scanError } = await supabase_1.supabase
            .from("scans")
            .select("*, projects(*)")
            .eq("id", scanId)
            .single();
        if (scanError || !scan) {
            throw new Error(`Scan not found: ${scanId}`);
        }
        // Update scan status to in_progress
        await supabase_1.supabase
            .from("scans")
            .update({
            status: "in_progress",
            started_at: new Date().toISOString(),
            queue_position: null,
        })
            .eq("id", scanId);
        logger_1.default.info(`Starting scan ${scanId} for project ${scan.project_id}`);
        // Start the crawler
        await crawler.startCrawl(scan);
        // Update scan status to completed
        await supabase_1.supabase
            .from("scans")
            .update({
            status: "completed",
            completed_at: new Date().toISOString(),
        })
            .eq("id", scanId);
        // Email the user if they have an email address
        if (scan.projects.notification_email) {
            const issuesResult = await supabase_1.supabase
                .from("issues")
                .select("*", { count: "exact", head: true })
                .eq("scan_id", scanId);
            const issueCount = issuesResult.count || 0;
            await (0, notifications_1.sendCompletionEmail)(scan.projects.notification_email, scan.projects.name, scanId, issueCount);
        }
        // Update the project's last_scan_at
        await supabase_1.supabase
            .from("projects")
            .update({
            last_scan_at: new Date().toISOString(),
        })
            .eq("id", scan.project_id);
        logger_1.default.info(`Completed scan ${scanId} for project ${scan.project_id}`);
        // Process the next scan in queue
        await processNextInQueue();
    }
    catch (error) {
        // Update scan status to failed
        await supabase_1.supabase
            .from("scans")
            .update({
            status: "failed",
            completed_at: new Date().toISOString(),
        })
            .eq("id", scanId);
        if (error instanceof Error) {
            logger_1.default.error(`Error in scan ${scanId}: ${error.message}`);
        }
        else {
            logger_1.default.error(`Unknown error in scan ${scanId}`);
        }
        // Still try to process the next scan in queue
        await processNextInQueue();
    }
    finally {
        // Remove from active scans
        activeScans.delete(scanId);
    }
}
// Get scan status
async function getScanStatus(scanId) {
    try {
        const { data, error } = await supabase_1.supabase
            .from("scans")
            .select("*")
            .eq("id", scanId)
            .single();
        if (error) {
            throw error;
        }
        return data;
    }
    catch (error) {
        logger_1.default.error(`Error getting scan status: ${error}`);
        return null;
    }
}
// Process the next scan in the queue
async function processNextInQueue() {
    try {
        // Find the next queued scan
        const { data: nextScans, error } = await supabase_1.supabase
            .from("scans")
            .select("id")
            .eq("status", "queued")
            .order("created_at", { ascending: true })
            .limit(1);
        if (error || !nextScans || nextScans.length === 0) {
            return; // No more scans to process
        }
        const nextScanId = nextScans[0].id;
        // Start the next scan
        startScan(nextScanId).catch((err) => {
            logger_1.default.error(`Error starting next scan: ${err}`);
        });
    }
    catch (error) {
        logger_1.default.error(`Error processing next scan in queue: ${error}`);
    }
}
// Initialize the scheduler for automatic scans
async function initScheduler() {
    try {
        logger_1.default.info("Initializing scheduler for automatic scans");
        // Schedule daily scans
        cron.schedule(config_1.default.scanFrequencies.daily, async () => {
            await scheduleFrequencyScans("daily");
        });
        // Schedule weekly scans
        cron.schedule(config_1.default.scanFrequencies.weekly, async () => {
            await scheduleFrequencyScans("weekly");
        });
        // Schedule monthly scans
        cron.schedule(config_1.default.scanFrequencies.monthly, async () => {
            await scheduleFrequencyScans("monthly");
        });
        logger_1.default.info("Scheduler initialized");
    }
    catch (error) {
        logger_1.default.error(`Error initializing scheduler: ${error}`);
    }
}
// Schedule scans for projects with a specific frequency
async function scheduleFrequencyScans(frequency) {
    try {
        logger_1.default.info(`Scheduling ${frequency} scans`);
        // Get all projects with this frequency
        const { data: projects, error } = await supabase_1.supabase
            .from("projects")
            .select("id")
            .eq("scan_frequency", frequency);
        if (error || !projects) {
            throw new Error(`Error getting ${frequency} projects: ${error === null || error === void 0 ? void 0 : error.message}`);
        }
        // Queue a scan for each project
        for (const project of projects) {
            try {
                await queueScan(project.id);
            }
            catch (err) {
                logger_1.default.error(`Error queueing ${frequency} scan for project ${project.id}: ${err}`);
            }
        }
        logger_1.default.info(`Scheduled ${projects.length} ${frequency} scans`);
    }
    catch (error) {
        logger_1.default.error(`Error scheduling ${frequency} scans: ${error}`);
    }
}
