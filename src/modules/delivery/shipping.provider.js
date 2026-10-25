import crypto from "node:crypto";
import axios from "axios";
import { AppError } from "../../common/errors/AppError.js";
import { timingSafeEqualString } from "../../common/timingSafe.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Adapter for our own delivery partner platform ("shipping"): a headless
 * delivery API with a shared driver pool. MealJi is one company (tenant) on it.
 *   - create → POST /v1/orders (pickup = the kitchen, drop = the customer)
 *   - status → signed webhooks (order.status_changed, driver.erased), see parseWebhook
 *   - live rider position and ETA → WebSocket stream, see shipping.stream.js
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

// Circuit breaker: after a run of failures that look like an outage, calls fail
// at once for a short while instead of each waiting for the timeout (keeps the
// event worker and the minute jobs moving while the platform is down).
const BREAKER = { failures: 0, openUntil: 0, threshold: 5, coolDownMs: 30_000 };

function outage(err) {
  return !err.response || err.response.status >= 500 || err.code === "ECONNABORTED";
}

/** A partner call through the breaker; an outage-like failure is marked `transient` (the call may have gone through). */
async function partner(fn) {
  if (Date.now() < BREAKER.openUntil) {
    const err = new Error("Delivery partner unavailable (paused after repeated failures)");
    err.transient = true;
    err.unsent = true;
    throw err;
  }
  try {
    const result = await fn(client());
    BREAKER.failures = 0;
    return result;
  } catch (err) {
    if (outage(err)) {
      BREAKER.failures += 1;
      if (BREAKER.failures >= BREAKER.threshold) BREAKER.openUntil = Date.now() + BREAKER.coolDownMs;
    }
    throw err;
  }
}

/** Turns an axios failure into a readable message (stored as the job's failure reason). */
function apiError(err) {
  if (err.unsent) return err;
  const detail = err.response?.data?.error;
  const error = new Error(detail ? `Delivery partner: ${detail.code} – ${detail.message}` : `Delivery partner unreachable: ${err.message}`);
  error.transient = outage(err);
  return error;
}

const point = (place) => ({ lat: Number(place.latitude), lng: Number(place.longitude) });
const rupeesToPaise = (amount) => (amount == null ? null : Math.round(Number(amount) * 100));

/**
 * The order body sent to the platform. `context` is built by the delivery
 * service for an order or a subscription meal drop: { reference, recipient:
 * { name, phone }, codPaise, deliverBy, kitchen }. Exported for tests.
 */
export function orderPayload(job, { reference, recipient, codPaise = 0, deliverBy = null, kitchen }) {
  const by = deliverBy ? new Date(deliverBy) : null;
  return {
    external_ref: reference,
    pickup: {
      name: kitchen.name,
      phone: kitchen.phoneNumber,
      address: job.pickup.address || kitchen.name,
      ...point(job.pickup),
    },
    drop: {
      name: recipient.name || "Customer",
      phone: recipient.phone,
      address: job.drop.address,
      ...point(job.drop),
    },
    package: { size: "small", fragile: false },
    priority: "standard",
    // The platform refuses deadlines in the past: only a future one is passed on.
    ...(by && by.getTime() > Date.now() + 60_000 ? { deliver_by: by.toISOString() } : {}),
    cod_amount: codPaise / 100,
    notes: `MealJi ${reference}`,
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
  if (event?.type === "driver.erased" && event.data?.driver_id) return { riderErased: String(event.data.driver_id) };
  if (event?.type !== "order.status_changed" || !event.data?.order_id) return null;
  const data = event.data;
  const status = STATUS_MAP[data.status] || null;
  const driver = data.driver;
  return {
    providerJobId: data.order_id,
    version: Number.isInteger(data.version) ? data.version : null,
    status,
    // Calls go through the platform: only its masked number is kept (never dialled directly).
    rider: status === "assigned" && driver?.name
      ? {
          name: driver.name,
          phone: null,
          phoneMasked: driver.phone_masked || null,
          vehicleNumber: null,
          vehicleType: driver.vehicle_type || null,
          externalId: driver.id ? String(driver.id) : null,
          photoUrl: driver.photo_url || null,
          rating: driver.rating ?? null,
          deliveriesCount: driver.deliveries_count ?? null,
        }
      : null,
    // Back to waiting for a driver (the rider handed it back): nobody is assigned now.
    clearRider: data.status === "created",
    subStatus: data.sub_status || null,
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
  // The created order carries the price: no separate quote call when booking.
  quoteOnCreate: true,

  /** No quote when no rider is free (so "best available partner" does not pick an empty pool); ETA = time to pickup. */
  async quote({ pickup, drop }) {
    try {
      const { data } = await partner((http) => http.post("/v1/quotes", { pickup: point(pickup), drop: point(drop) }));
      if (data.drivers_available === 0) return null;
      return { pricePaise: rupeesToPaise(data.price?.amount), etaMinutes: data.estimated_minutes_to_pickup ?? null };
    } catch (err) {
      throw apiError(err);
    }
  },

  /** The request saved on the job before the call, so a retry sends exactly the same body. */
  requestFor(job, context) {
    return orderPayload(job, context);
  },

  async create(job, context) {
    try {
      // The job id as idempotency key and the saved request as body: a retried
      // call returns the delivery already created instead of booking a second rider.
      const body = job.providerRequest || orderPayload(job, context);
      const { data } = await partner((http) => http.post("/v1/orders", body, { headers: { "Idempotency-Key": String(job._id) } }));
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

  /** Cancels on the platform; resolves only when the delivery is (now or already) cancelled there. */
  async cancel(job) {
    if (!job.providerJobId) return;
    try {
      await partner((http) => http.post(`/v1/orders/${job.providerJobId}/cancel`, { reason: "Cancelled by MealJi" }));
    } catch (err) {
      if (err.response?.status === 409) {
        const status = await partner((http) => http.get(`/v1/orders/${job.providerJobId}`)).then((res) => res.data?.status).catch(() => null);
        if (status === "cancelled") return;
        throw new AppError(409, "The rider already has the food, so this delivery can't be cancelled");
      }
      // The partner's own text stays in the logs; the user gets a plain message.
      logger.error({ jobId: String(job._id), providerJobId: job.providerJobId, error: apiError(err).message }, "Delivery partner cancel failed");
      throw new AppError(502, "Couldn't cancel the delivery right now. Please try again.", null, { expose: true });
    }
  },

  /** Rings the customer (the drop phone given at booking) and connects them to the rider; numbers stay hidden. */
  async callRider(job) {
    try {
      await partner((http) => http.post(`/v1/orders/${job.providerJobId}/call`, {})); // JSON body: the platform rejects a bare form post
      return { calling: true };
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === "no_active_driver") throw new AppError(409, "The rider can be called while they are on the way");
      if (code === "calls_not_masked") throw new AppError(409, "Calling the rider is not available right now");
      if (code === "number_not_allowed") throw new AppError(409, "Calling isn't available for this phone number");
      if (code === "too_many_calls") throw new AppError(429, "Too many calls for this delivery. Please try again later.");
      throw new AppError(502, "Couldn't connect the call. Please try again.", null, { expose: true });
    }
  },

  /** Passes the customer's delivery stars on to the rider's profile (once per delivery; no review text). */
  async rate(job, { rating }) {
    try {
      await partner((http) => http.post(`/v1/orders/${job.providerJobId}/rating`, { rating }));
    } catch (err) {
      if (err.response?.status === 409) return; // already rated, or not rateable
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
