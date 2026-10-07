import { assertRuntimeEnv } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { logger } from "./config/logger.js";
import { redis } from "./config/redis.js";
import { startBackground, stopBackground } from "./jobs/runtime.js";

// Background process: `npm run worker`. In production run one or more of these
// next to the api (with RUN_WORKERS_IN_API=false on the api).
async function start() {
  try {
    assertRuntimeEnv();
  } catch (err) {
    logger.error({ err: err.message }, "Invalid environment");
    process.exit(1);
  }

  await connectDatabase();
  await redis.connect().catch((err) => logger.warn({ err: err.message }, "Redis unavailable for the worker"));
  await startBackground({ role: "worker" });

  async function shutdown(signal) {
    logger.info({ signal }, "Worker shutting down");
    await stopBackground().catch(() => {});
    await disconnectDatabase().catch(() => {});
    redis.disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});
