import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

/**
 * Realtime fan-out. Any process (api or worker) calls `publish(room, type, data)`.
 * With Redis the message goes through pub/sub so every api node delivers it to
 * its own sockets; without Redis (development) it is delivered in-process.
 * Rooms: user:{id}, order:{id}, kitchen:{id}, admin:ops.
 */

const CHANNEL = `${env.redisKeyPrefix}realtime`;
const localListeners = new Set();
let publisher = null;
let subscriber = null;
let bridged = false;

function connection() {
  return new Redis({
    host: env.redisHost,
    port: env.redisPort,
    password: env.redisPassword || undefined,
    tls: env.redisTls ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
}

function deliverLocal(message) {
  for (const listener of localListeners) {
    try {
      listener(message);
    } catch (err) {
      logger.warn({ err: err.message }, "Realtime listener failed");
    }
  }
}

/** Starts the Redis bridge. Safe to call more than once. */
export async function startHub({ subscribe = false } = {}) {
  try {
    if (!publisher) {
      publisher = connection();
      publisher.on("error", () => {});
      await publisher.connect();
    }
    if (subscribe && !subscriber) {
      subscriber = connection();
      subscriber.on("error", () => {});
      await subscriber.connect();
      await subscriber.subscribe(CHANNEL);
      subscriber.on("message", (channel, raw) => {
        if (channel !== CHANNEL) return;
        try {
          deliverLocal(JSON.parse(raw));
        } catch {
          // ignore malformed
        }
      });
    }
    bridged = publisher.status === "ready";
  } catch (err) {
    bridged = false;
    logger.warn({ err: err.message }, "Realtime bridge unavailable, delivering in-process only");
  }
}

export function onMessage(listener) {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}

export function publish(room, type, data) {
  const message = { room, type, data, at: new Date().toISOString() };
  if (bridged && publisher?.status === "ready") {
    publisher.publish(CHANNEL, JSON.stringify(message)).catch(() => deliverLocal(message));
  } else {
    deliverLocal(message);
  }
}

export async function stopHub() {
  bridged = false;
  publisher?.disconnect();
  subscriber?.disconnect();
  publisher = null;
  subscriber = null;
}
