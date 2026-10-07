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
  retryStrategy(times) {
    if (env.isProd && times > 3) return null;
    return Math.min(times * 200, 2000);
  },
});

redis.on("error", (err) => {
  logger.warn({ err: err.message }, "Redis error");
});
