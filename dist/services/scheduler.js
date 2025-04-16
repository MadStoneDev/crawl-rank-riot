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
exports.initScheduler = initScheduler;
const cron = __importStar(require("node-cron"));
const supabase_1 = require("../db/supabase");
const scanner = __importStar(require("./scanner"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
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
        if (error instanceof Error) {
            logger_1.default.error(`Error initializing scheduler: ${error.message}`);
        }
        else {
            logger_1.default.error("Unknown error initializing scheduler");
        }
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
        if (error) {
            throw new Error(`Error getting ${frequency} projects: ${error.message}`);
        }
        if (!projects || projects.length === 0) {
            logger_1.default.info(`No projects found with ${frequency} scan frequency`);
            return;
        }
        // Queue a scan for each project
        for (const project of projects) {
            try {
                await scanner.queueScan(project.id);
                logger_1.default.info(`Queued ${frequency} scan for project ${project.id}`);
            }
            catch (err) {
                if (err instanceof Error) {
                    logger_1.default.error(`Error queueing ${frequency} scan for project ${project.id}: ${err.message}`);
                }
                else {
                    logger_1.default.error(`Unknown error queueing ${frequency} scan for project ${project.id}`);
                }
            }
        }
        logger_1.default.info(`Scheduled ${projects.length} ${frequency} scans`);
    }
    catch (error) {
        if (error instanceof Error) {
            logger_1.default.error(`Error scheduling ${frequency} scans: ${error.message}`);
        }
        else {
            logger_1.default.error(`Unknown error scheduling ${frequency} scans`);
        }
    }
}
