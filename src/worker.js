import { assertRuntimeEnv } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { logger } from "./config/logger.js";
import { redis } from "./config/redis.js";
import { storeSet } from "./infrastructure/redisStore.js";
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

  // Heartbeat: /health/ready and /metrics show "stale" when the worker stops checking in.
  const beat = () => storeSet("worker:heartbeat", String(Date.now()), 300).catch(() => {});
  await beat();
  const heartbeat = setInterval(beat, 30_000);

  let stopping = false;
  async function shutdown(signal, code = 0) {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Worker shutting down");
    clearInterval(heartbeat);
    setTimeout(() => process.exit(code), 15_000).unref();
    await stopBackground().catch(() => {});
    await disconnectDatabase().catch(() => {});
    redis.disconnect();
    process.exit(code);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ err: reason?.stack || String(reason) }, "Unhandled promise rejection"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: err?.stack || String(err) }, "Uncaught exception");
    shutdown("uncaughtException", 1);
  });
}

start().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});
