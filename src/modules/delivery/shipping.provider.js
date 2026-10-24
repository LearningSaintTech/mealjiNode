import crypto from "node:crypto";
import axios from "axios";
import { AppError } from "../../common/errors/AppError.js";
import { timingSafeEqualString } from "../../common/timingSafe.js";
import { env } from "../../config/env.js";

/**
 * Adapter for our own delivery partner platform ("shipping"): a headless
 * delivery API with a shared driver pool. MealJi is one company (tenant) on it.
 *   - create → POST /v1/orders (pickup = the kitchen, drop = the customer)
 *   - status → signed webhooks (order.status_changed), see parseWebhook
 *   - live rider position → WebSocket stream, see shipping.stream.js
 */

const WEBHOOK_TOLERANCE_S = 300;

// Public status on the platform → DeliveryJob status. Delivery failures after
// pickup stay "failed" (the watchdog does not re-book a parcel that left the
// kitchen); a cancellation on their side (ops, unknown address) is "failed" too,
// so the watchdog books again.
const STATUS_MAP = {
  created: "booked", // waiting for a driver again (e.g. the driver handed it back)
  assigned: "assigned",
  picked_up: "picked_up",
  out_for_delivery: "picked_up",
  delivered: "delivered",
  failed: "failed",
  returned: "failed",
  cancelled: "failed",
};

export function shippingConfigured() {
  return Boolean(env.shippingApiUrl && env.shippingApiKey);
}

function client() {
  return axios.create({
    baseURL: env.shippingApiUrl,
    timeout: 10_000,
    headers: { Authorization: `Bearer ${env.shippingApiKey}` },
  });
}

/** Turns an axios failure into a readable message (stored as the job's failure reason). */
function apiError(err) {
  const detail = err.response?.data?.error;
  return new Error(detail ? `Delivery partner: ${detail.code} – ${detail.message}` : `Delivery partner unreachable: ${err.message}`);
}

const point = (place) => ({ lat: Number(place.latitude), lng: Number(place.longitude) });
const rupeesToPaise = (amount) => (amount == null ? null : Math.round(Number(amount) * 100));

/** The order body sent to the platform. Exported for tests. */
export function orderPayload(job, { order, kitchen }) {
  const drop = order.address || {};
  const cod = order.paymentMethod === "cod" && order.paymentStatus === "cod_pending";
  const deliverBy = order.estimatedDeliveryAt ? new Date(order.estimatedDeliveryAt) : null;
  return {
    external_ref: order.orderNumber,
    pickup: {
      name: kitchen.name,
      phone: kitchen.phoneNumber,
      address: job.pickup.address || kitchen.name,
      ...point(job.pickup),
    },
    drop: {
      name: drop.recipientName || order.customer?.name || "Customer",
      phone: drop.phone || order.customer?.phone,
      address: job.drop.address,
      ...point(job.drop),
    },
    package: { size: "small", fragile: false },
    priority: "standard",
    // The platform refuses deadlines in the past: only a future ETA is passed on.
    ...(deliverBy && deliverBy.getTime() > Date.now() + 60_000 ? { deliver_by: deliverBy.toISOString() } : {}),
    cod_amount: cod ? (order.bill?.grandTotalPaise ?? 0) / 100 : 0,
    notes: `MealJi order ${order.orderNumber}`,
  };
}

/** Checks x-signature (or x-signature-previous during a secret rotation) over "timestamp.body". */
export function verifySignature(rawBody, headers, secret, now = Date.now()) {
  const timestamp = String(headers["x-timestamp"] || "");
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
  return [headers["x-signature"], headers["x-signature-previous"]].some((sig) => sig && timingSafeEqualString(expected, String(sig)));
}

/** Webhook payload → DeliveryJob update, or null for events that change nothing here. Exported for tests. */
export function toUpdate(event) {
  if (event?.type !== "order.status_changed" || !event.data?.order_id) return null;
  const data = event.data;
  const status = STATUS_MAP[data.status] || null;
  const driver = data.driver;
  return {
    providerJobId: data.order_id,
    version: Number.isInteger(data.version) ? data.version : null,
    status,
    // A driver who handed the order back is replaced on the next "assigned".
    rider: status === "assigned" && driver?.name ? { name: driver.name, phone: driver.phone_masked || null, vehicleNumber: null } : null,
    location: data.location?.lat != null ? { lat: data.location.lat, lng: data.location.lng } : null,
    // Every status from picked_up on means the food left the kitchen, even if the picked_up event itself lost a race.
    pickedUp: ["picked_up", "out_for_delivery", "delivered", "failed", "returned"].includes(data.status),
    note: data.reason || (data.sub_status && data.sub_status !== data.status ? data.sub_status : null),
  };
}

export const shippingProvider = {
  key: "shipping",
  label: "MealJi delivery platform",
  managedByKitchen: false,

  async quote({ pickup, drop }) {
    try {
      const { data } = await client().post("/v1/quotes", { pickup: point(pickup), drop: point(drop) });
      return { pricePaise: rupeesToPaise(data.price?.amount), etaMinutes: data.estimated_minutes_to_delivery ?? null };
    } catch (err) {
      throw apiError(err);
    }
  },

  async create(job, context) {
    try {
      // The job id as idempotency key: a retried call never books a second driver;
      // a re-book is a new job, so it gets a new delivery.
      const { data } = await client().post("/v1/orders", orderPayload(job, context), { headers: { "Idempotency-Key": String(job._id) } });
      return {
        providerJobId: data.id,
        status: "booked",
        trackingUrl: null,
        costPaise: rupeesToPaise(data.price?.amount),
        deliveryOtp: data.delivery_otp || null,
      };
    } catch (err) {
      throw apiError(err);
    }
  },

  async cancel(job) {
    if (!job.providerJobId) return;
    try {
      await client().post(`/v1/orders/${job.providerJobId}/cancel`, { reason: "Cancelled by MealJi" });
    } catch (err) {
      // Already cancelled or delivered on their side: nothing left to cancel.
      if (err.response?.status === 409) return;
      throw apiError(err);
    }
  },

  parseWebhook(rawBody, headers) {
    if (!env.shippingWebhookSecret) throw new AppError(401, "Not configured");
    if (!Buffer.isBuffer(rawBody) || !verifySignature(rawBody, headers, env.shippingWebhookSecret)) throw new AppError(401, "Invalid signature");
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new AppError(400, "Invalid JSON");
    }
    return toUpdate(event);
  },
};
