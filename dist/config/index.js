"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const config = {
    port: parseInt(process.env.PORT || "3000", 10),
    nodeEnv: process.env.NODE_ENV || "development",
    supabase: {
        url: process.env.SUPABASE_URL || "",
        serviceKey: process.env.SUPABASE_SERVICE_KEY || "",
    },
    crawler: {
        concurrency: 3,
        timeout: 30000, // 30 seconds
        delay: 1000, // 1 second between requests
        maxPages: 100, // Default page limit
        respectRobotsTxt: true,
    },
    mailersend: {
        apiKey: process.env.MAILERSEND_API_TOKEN || "",
        enabled: process.env.MAILERSEND_ENABLED === "true",
    },
    scanFrequencies: {
        daily: "0 0 * * *", // Run at midnight every day
        weekly: "0 0 * * 0", // Run at midnight every Sunday
        monthly: "0 0 1 * *", // Run at midnight on the 1st of each month
    },
};
// Validate required environment variables
if (!config.supabase.url || !config.supabase.serviceKey) {
    throw new Error("Missing required environment variables for Supabase");
}
exports.default = config;
