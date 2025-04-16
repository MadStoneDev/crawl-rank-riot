"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
exports.testConnection = testConnection;
const supabase_js_1 = require("@supabase/supabase-js");
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../utils/logger"));
// Create a single supabase client for the entire app
const supabase = (0, supabase_js_1.createClient)(config_1.default.supabase.url, config_1.default.supabase.serviceKey, {
    auth: {
        persistSession: false,
    },
});
exports.supabase = supabase;
// Test the connection
async function testConnection() {
    try {
        const { data, error } = await supabase
            .from("projects")
            .select("id")
            .limit(1);
        if (error)
            throw error;
        logger_1.default.info("Connected to Supabase successfully");
    }
    catch (error) {
        logger_1.default.error("Failed to connect to Supabase:", error);
        process.exit(1);
    }
}
