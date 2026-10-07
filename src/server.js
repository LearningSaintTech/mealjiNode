import { env, assertRuntimeEnv } from "./config/env.js";
import { logger } from "./config/logger.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { redis } from "./config/redis.js";
import { app } from "./app.js";
import { startBackground, stopBackground } from "./jobs/runtime.js";
import { attachRealtime } from "./realtime/socket.js";

async function connectRedis() {
  const attempt = redis.connect()
    .then(() => "ready")
    .catch((err) => ({ error: err }));

  const result = env.isProd
    ? await attempt
    : await Promise.race([
      attempt,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 2500)),
    ]);

  if (result === "ready" || redis.status === "ready") {
    logger.info("Redis connected");
    return;
  }

  const message = result === "timeout"
    ? "Redis connection timed out"
    : result?.error?.message || "Redis connection failed";

  if (env.isProd) {
    logger.error({ err: message }, "Redis connection failed");
    process.exit(1);
  }

  logger.warn({ err: message }, "Redis unavailable, using in-memory fallback");
}

async function start() {
  try {
    assertRuntimeEnv();
  } catch (err) {
    logger.error({ err: err.message }, "Invalid environment");
    process.exit(1);
  }

  await connectDatabase();
  await connectRedis();
  if (env.runWorkersInApi) {
    await startBackground({ role: "api" }).catch((err) => logger.error({ err: err.message }, "Background workers failed to start"));
  }

  const server = app.listen(env.port, () => {
    logger.info({ port: env.port, maps: Boolean(env.googleMapsApiKey) }, "mealJiNode listening");
  });
  await attachRealtime(server).catch((err) => logger.error({ err: err.message }, "Realtime failed to start"));

  async function shutdown(signal) {
    logger.info({ signal }, "Shutting down");
    server.close(async () => {
      await stopBackground().catch(() => {});
      await disconnectDatabase().catch(() => {});
      redis.disconnect();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  logger.error({ err }, "Failed to start");
  process.exit(1);
});
