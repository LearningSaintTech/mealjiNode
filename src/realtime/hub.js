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
const RETRY_MS = 5000;
const localListeners = new Set();
let publisher = null;
let subscriber = null;
let subscribed = false;

function connection(options = {}) {
  return new Redis({
    host: env.redisHost,
    port: env.redisPort,
    password: env.redisPassword || undefined,
    tls: env.redisTls ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    ...options,
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

const current = (client) => client && (client === publisher || client === subscriber);

/**
 * Connects and keeps trying. ioredis reconnects by itself after a dropped
 * connection, but a failed first attempt can leave it closed for good ("end"):
 * then we start again, so a Redis that comes up after the process still gets used.
 */
async function keepConnected(client, label) {
  try {
    await client.connect();
  } catch (err) {
    logger.warn({ err: err.message, connection: label }, "Realtime bridge not connected yet, delivering in-process until it is");
  }
}

function watch(client, label) {
  client.on("error", () => {});
  client.on("end", () => {
    if (!current(client)) return; // stopped on purpose
    const timer = setTimeout(() => {
      if (current(client) && (client.status === "end" || client.status === "wait")) keepConnected(client, label);
    }, RETRY_MS);
    timer.unref?.();
  });
}

/**
 * Where a message goes. Through Redis whenever the publisher is ready (decided
 * per message, so a late or reconnected Redis is picked up). In-process when it
 * is not (single-process development), and also when this process has sockets
 * but its subscription is down: its own sockets would otherwise miss it.
 */
export function deliveryRoute({ publisherReady, hasSubscriber, subscribed: isSubscribed }) {
  if (!publisherReady) return { redis: false, local: true };
  return { redis: true, local: hasSubscriber && !isSubscribed };
}

/** Starts the Redis bridge. Safe to call more than once; never throws. */
export async function startHub({ subscribe = false } = {}) {
  const pending = [];
  if (!publisher) {
    publisher = connection();
    watch(publisher, "publisher");
    pending.push(keepConnected(publisher, "publisher"));
  }
  if (subscribe && !subscriber) {
    const client = connection({ autoResubscribe: false });
    subscriber = client;
    watch(client, "subscriber");
    client.on("message", (channel, raw) => {
      if (channel !== CHANNEL) return;
      try {
        deliverLocal(JSON.parse(raw));
      } catch {
        // ignore malformed
      }
    });
    // Subscribe on every (re)connect: a connection that comes up late or after a drop still listens.
    client.on("ready", () => {
      client.subscribe(CHANNEL).then(() => {
        if (current(client)) subscribed = true;
      }, (err) => logger.warn({ err: err.message }, "Realtime subscribe failed"));
    });
    client.on("close", () => {
      if (client === subscriber) subscribed = false;
    });
    pending.push(keepConnected(client, "subscriber"));
  }
  await Promise.all(pending);
}

export function onMessage(listener) {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}

export function publish(room, type, data) {
  const message = { room, type, data, at: new Date().toISOString() };
  const route = deliveryRoute({ publisherReady: publisher?.status === "ready", hasSubscriber: Boolean(subscriber), subscribed });
  if (route.local) deliverLocal(message);
  if (route.redis) {
    publisher.publish(CHANNEL, JSON.stringify(message)).catch(() => {
      if (!route.local) deliverLocal(message);
    });
  }
}

export async function stopHub() {
  const clients = [publisher, subscriber];
  publisher = null;
  subscriber = null;
  subscribed = false;
  for (const client of clients) client?.disconnect();
}
