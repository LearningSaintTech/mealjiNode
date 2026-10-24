import WebSocket from "ws";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { acquireLock, releaseLock, storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { applyProviderLocation } from "./delivery.service.js";
import { shippingConfigured } from "./shipping.provider.js";

/**
 * Live rider positions from the delivery platform. Status changes arrive as
 * webhooks; GPS points come over its WebSocket stream (`/v1/stream`), are
 * forwarded as `track:location` / `meal:location` (with the platform's ETA)
 * and kept as the job's last location. Only one background process holds the connection at a time (a
 * Redis lock, renewed while connected); the others stand by and take over
 * when it stops. The holder reconnects with backoff.
 */

const MIN_INTERVAL_MS = 5_000; // per order: the app does not need every ping
const LOCK_KEY = "delivery:shipping-stream";
const LOCK_TTL_S = 30;
const LEADER_CHECK_MS = 10_000;
const lastApplied = new Map();
let socket = null;
let stopped = true;
let lockToken = null;
let leaderTimer = null;
let retryTimer = null;
let attempt = 0;

function streamUrl() {
  return `${env.shippingApiUrl.replace(/^http/, "ws")}/v1/stream`;
}

async function onMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (message.type !== "location" || !message.order_id || message.driver_location?.lat == null) return;
  const now = Date.now();
  if (now - (lastApplied.get(message.order_id) || 0) < MIN_INTERVAL_MS) return;
  lastApplied.set(message.order_id, now);
  if (lastApplied.size > 5_000) lastApplied.clear();
  const point = message.driver_location;
  await applyProviderLocation("shipping", message.order_id, {
    lat: point.lat,
    lng: point.lng,
    heading: point.heading ?? null,
    speed: point.speed_kmph ?? null,
  }, { eta: message.eta || null, remainingDistanceM: message.remaining_distance_m ?? null }).catch((err) => logger.warn({ err: err.message }, "Delivery platform location not applied"));
}

function connect() {
  if (stopped || !lockToken || socket) return;
  socket = new WebSocket(streamUrl(), { headers: { Authorization: `Bearer ${env.shippingApiKey}` } });
  socket.on("open", () => {
    attempt = 0;
    logger.info("Delivery platform stream connected");
  });
  socket.on("message", onMessage);
  socket.on("error", (err) => logger.warn({ err: err.message }, "Delivery platform stream error"));
  socket.on("close", () => {
    socket = null;
    if (stopped || !lockToken) return;
    const delay = Math.min(60_000, 1_000 * 2 ** attempt++);
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  });
}

function disconnect() {
  clearTimeout(retryTimer);
  socket?.close();
  socket = null;
}

/** Takes, keeps or loses the connection depending on who holds the lock. */
async function leaderCheck() {
  if (stopped) return;
  try {
    if (lockToken) {
      const { ok, value } = await storeGetOptional(LOCK_KEY);
      if (ok && value === lockToken) {
        await storeSet(LOCK_KEY, lockToken, LOCK_TTL_S);
      } else if (ok) {
        // Lost it (e.g. paused past the TTL): another process has the stream now.
        lockToken = null;
        disconnect();
        logger.info("Delivery platform stream handed to another process");
      }
    } else {
      lockToken = await acquireLock(LOCK_KEY, LOCK_TTL_S);
      if (lockToken) connect();
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Delivery platform stream lock check failed");
  }
}

export function startShippingStream() {
  if (!shippingConfigured() || !stopped) return;
  stopped = false;
  leaderCheck();
  leaderTimer = setInterval(leaderCheck, LEADER_CHECK_MS);
  leaderTimer.unref?.();
}

export function stopShippingStream() {
  stopped = true;
  clearInterval(leaderTimer);
  disconnect();
  releaseLock(LOCK_KEY, lockToken).catch(() => {});
  lockToken = null;
}
