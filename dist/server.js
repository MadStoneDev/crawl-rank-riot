"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./app"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./utils/logger"));
const scheduler_1 = require("./services/scheduler");
const supabase_1 = require("./db/supabase");
async function startServer() {
    try {
        // Test database connection
        await (0, supabase_1.testConnection)();
        // Initialize the scheduler
        await (0, scheduler_1.initScheduler)();
        // Start the server
        app_1.default.listen(config_1.default.port, () => {
            logger_1.default.info(`Server running on port ${config_1.default.port} in ${config_1.default.nodeEnv} mode`);
        });
    }
    catch (error) {
        if (error instanceof Error) {
            logger_1.default.error("Failed to start server:", error.message);
        }
        else {
            logger_1.default.error("Failed to start server with unknown error");
        }
        process.exit(1);
    }
}
startServer();
