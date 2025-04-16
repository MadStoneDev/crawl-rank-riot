import app from "./app";
import config from "./config";
import logger from "./utils/logger";
import { initScheduler } from "./services/scheduler";

import { testConnection } from "./db/supabase";

async function startServer(): Promise<void> {
  try {
    // Test database connection
    await testConnection();

    // Initialize the scheduler
    await initScheduler();

    // Start the server
    app.listen(config.port, () => {
      logger.info(
        `Server running on port ${config.port} in ${config.nodeEnv} mode`,
      );
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Failed to start server:", error.message);
    } else {
      logger.error("Failed to start server with unknown error");
    }
    process.exit(1);
  }
}

startServer();
