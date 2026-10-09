import Redis from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";

export const redis = new Redis({
  host: env.redisHost,
  port: env.redisPort,
  password: env.redisPassword || undefined,
  tls: env.redisTls ? {} : undefined,
  keyPrefix: env.redisKeyPrefix,
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  // Never give up: after an outage the API reconnects by itself (backoff up to 5 s).
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

redis.on("error", (err) => {
  logger.warn({ err: err.message }, "Redis error");
});
