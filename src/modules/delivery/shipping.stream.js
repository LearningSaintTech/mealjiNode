import WebSocket from "ws";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { applyProviderLocation } from "./delivery.service.js";
import { shippingConfigured } from "./shipping.provider.js";

/**
 * Live rider positions from the delivery platform. Status changes arrive as
 * webhooks; GPS points come over its WebSocket stream (`/v1/stream`), are
 * forwarded as `track:location` and kept as the job's last location.
 * One connection per background process, reconnecting with backoff.
 */

const MIN_INTERVAL_MS = 5_000; // per order: the app does not need every ping
const lastApplied = new Map();
let socket = null;
let stopped = true;
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
  }).catch((err) => logger.warn({ err: err.message }, "Delivery platform location not applied"));
}

function connect() {
  if (stopped) return;
  socket = new WebSocket(streamUrl(), { headers: { Authorization: `Bearer ${env.shippingApiKey}` } });
  socket.on("open", () => {
    attempt = 0;
    logger.info("Delivery platform stream connected");
  });
  socket.on("message", onMessage);
  socket.on("error", (err) => logger.warn({ err: err.message }, "Delivery platform stream error"));
  socket.on("close", () => {
    socket = null;
    if (stopped) return;
    const delay = Math.min(60_000, 1_000 * 2 ** attempt++);
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  });
}

export function startShippingStream() {
  if (!shippingConfigured() || !stopped) return;
  stopped = false;
  connect();
}

export function stopShippingStream() {
  stopped = true;
  clearTimeout(retryTimer);
  socket?.close();
  socket = null;
}
