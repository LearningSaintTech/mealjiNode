import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { maskPhone } from "../../common/phone.util.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { publish } from "../../realtime/hub.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { Order } from "../order/order.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { DeliveryJob, DeliveryProviderAccount } from "./delivery.model.js";
import { getProvider, listProviders } from "./providers.js";

export function toJob(job) {
  return {
    jobId: String(job._id),
    orderId: job.order ? String(job.order._id || job.order) : null,
    orderNumber: job.order?.orderNumber || null,
    mealDropId: job.mealDrop ? String(job.mealDrop) : null,
    kitchenId: String(job.kitchen?._id || job.kitchen),
    kitchenName: job.kitchen?.name || null,
    provider: job.provider,
    providerJobId: job.providerJobId,
    status: job.status,
    quotePaise: job.quotePaise,
    costPaise: job.costPaise,
    rider: job.rider?.name ? { name: job.rider.name, phone: job.rider.phone, phoneMasked: job.rider.phone ? maskPhone(job.rider.phone) : null, vehicleNumber: job.rider.vehicleNumber } : null,
    trackingUrl: job.trackingUrl,
    attempts: job.attempts,
    failureReason: job.failureReason,
    bookedAt: job.bookedAt,
    pickedUpAt: job.pickedUpAt,
    deliveredAt: job.deliveredAt,
    lastLocation: job.lastLocation?.lat != null ? job.lastLocation : null,
    history: job.history || [],
    createdAt: job.createdAt,
  };
}

async function deliverySettings(kitchenId) {
  return (await resolveSetting("delivery", { kitchenId })).values;
}

/** Books a delivery for an order with the kitchen's configured provider. */
export async function bookForOrder(orderId, { by = "system", provider = null } = {}) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError(404, "Order not found");
  if (order.deliveryMode === "pickup") throw new AppError(409, "Pickup orders are not delivered");
  if (["delivered", "cancelled"].includes(order.status)) throw new AppError(409, "This order is closed");
  const existing = order.deliveryJob ? await DeliveryJob.findById(order.deliveryJob) : null;
  if (existing && !["cancelled", "failed"].includes(existing.status)) return existing;

  const settings = await deliverySettings(order.kitchen);
  const kitchen = await Kitchen.findById(order.kitchen).lean();
  let key = provider || settings.provider;
  if (key === "self" && !settings.selfDeliveryAllowed && provider) throw new AppError(403, "Self delivery is not allowed for this kitchen");
  if (key === "auto") key = await chooseProvider(kitchen, order, settings.autoSelect);
  const adapter = getProvider(key);
  const job = new DeliveryJob({
    order: order._id,
    kitchen: order.kitchen,
    provider: adapter.key,
    status: "pending",
    pickup: { latitude: kitchen.latitude, longitude: kitchen.longitude, address: [kitchen.addressLine, kitchen.area, kitchen.city].filter(Boolean).join(", ") },
    drop: { latitude: order.address?.latitude, longitude: order.address?.longitude, address: order.address?.fullAddress },
    attempts: existing ? existing.attempts + 1 : 1,
    history: [{ status: "pending", at: new Date(), by }],
  });
  try {
    const quote = await adapter.quote({ pickup: job.pickup, drop: job.drop });
    if (quote) job.quotePaise = quote.pricePaise;
    const created = await adapter.create(job);
    job.providerJobId = created.providerJobId;
    job.status = created.status || "booked";
    job.trackingUrl = created.trackingUrl || null;
    job.bookedAt = new Date();
    job.history.push({ status: job.status, at: new Date(), by });
  } catch (err) {
    job.status = "failed";
    job.failureReason = err.message;
    job.history.push({ status: "failed", at: new Date(), note: err.message, by });
    logger.warn({ err: err.message, orderId: String(order._id) }, "Delivery booking failed");
  }
  await job.save();
  order.deliveryJob = job._id;
  await order.save();
  await publishEventSafe(job.status === "failed" ? "delivery.failed" : "delivery.booked", { jobId: String(job._id), orderId: String(order._id), provider: job.provider });
  publish(`kitchen:${order.kitchen}`, "kitchen:delivery_updated", toJob(job));
  return job;
}

/**
 * Applies a delivery status change (from the kitchen for manual/self jobs, or a
 * provider webhook) and moves the order with it: picked_up → dispatched,
 * delivered → delivered.
 */
export async function updateJob(job, { status, rider = null, costPaise = null, location = null, note = null, by = "system" }) {
  const { transition } = await import("../order/order.service.js");
  const order = job.order ? await Order.findById(job.order) : null;
  if (rider?.name) {
    job.rider = { name: rider.name, phone: rider.phone || null, vehicleNumber: rider.vehicleNumber || null };
    if (order) {
      order.rider = job.rider;
      await order.save();
      publish(`order:${order._id}`, "order:rider_assigned", { orderId: String(order._id), rider: { name: rider.name, phoneMasked: rider.phone ? maskPhone(rider.phone) : null, vehicleNumber: rider.vehicleNumber || null } });
    }
    if (status == null && job.status === "booked") status = "assigned";
  }
  if (costPaise != null) job.costPaise = costPaise;
  if (location) {
    job.lastLocation = { ...location, at: new Date() };
    if (order) publish(`order:${order._id}`, "track:location", { orderId: String(order._id), lat: location.lat, lng: location.lng, heading: location.heading ?? null, speed: location.speed ?? null, updatedAt: new Date().toISOString() });
  }
  if (status && status !== job.status) {
    job.status = status;
    job.history.push({ status, at: new Date(), note, by });
    if (status === "picked_up") job.pickedUpAt = new Date();
    if (status === "delivered") job.deliveredAt = new Date();
    await publishEventSafe(`delivery.${status}`, { jobId: String(job._id), orderId: order ? String(order._id) : null });
  }
  await job.save();
  if (order) {
    const actor = by === "kitchen" ? "kitchen" : by === "admin" ? "admin" : "system";
    if (status === "picked_up" && order.status === "ready") await transition(order._id, "dispatched", { actor, note: "Rider picked up" });
    if (status === "delivered" && ["ready", "dispatched"].includes(order.status)) {
      if (order.status === "ready") await transition(order._id, "dispatched", { actor, note: "Rider picked up" });
      await transition(order._id, "delivered", { actor, note: "Delivered" });
    }
    publish(`kitchen:${order.kitchen}`, "kitchen:delivery_updated", toJob(job));
  }
  return job;
}

export async function cancelJob(job, { reason, by }) {
  const adapter = getProvider(job.provider);
  await adapter.cancel(job).catch((err) => logger.warn({ err: err.message }, "Provider cancel failed"));
  return updateJob(job, { status: "cancelled", note: reason, by });
}

/**
 * Multi-provider selection (Phase 5): asks every active partner account that
 * covers the kitchen for a quote and picks the cheapest (or fastest). Falls
 * back to the manual provider when no partner answers.
 */
export async function chooseProvider(kitchen, order, prefer = "cheapest") {
  const accounts = await DeliveryProviderAccount.find({ isActive: true }).lean();
  const city = String(kitchen.city || "").toLowerCase();
  const eligible = accounts.filter((account) => (!account.kitchens?.length || account.kitchens.map(String).includes(String(kitchen._id))) && (!account.cities?.length || account.cities.includes(city)));
  const quotes = [];
  for (const account of eligible) {
    const adapter = getProvider(account.provider);
    if (adapter.key !== account.provider) continue;
    try {
      const quote = await adapter.quote({ pickup: { latitude: kitchen.latitude, longitude: kitchen.longitude }, drop: { latitude: order.address?.latitude, longitude: order.address?.longitude }, account });
      if (quote) quotes.push({ provider: account.provider, ...quote });
    } catch (err) {
      logger.warn({ err: err.message, provider: account.provider }, "Delivery quote failed");
    }
  }
  if (!quotes.length) return "manual";
  quotes.sort((a, b) => (prefer === "fastest" ? (a.etaMinutes ?? 999) - (b.etaMinutes ?? 999) : a.pricePaise - b.pricePaise));
  return quotes[0].provider;
}

export async function saveProviderAccount(accountId, input) {
  const data = {};
  for (const key of ["provider", "name", "credentials", "cities", "isActive"]) if (input[key] !== undefined) data[key] = input[key];
  if (input.kitchenIds !== undefined) data.kitchens = input.kitchenIds.map((id) => objectId(id, "kitchen ID"));
  if (data.cities) data.cities = data.cities.map((city) => String(city).toLowerCase().trim());
  if (!accountId && (!data.provider || !data.name)) throw new AppError(422, "Provider and name are required");
  const account = accountId ? await DeliveryProviderAccount.findByIdAndUpdate(objectId(accountId, "account ID"), { $set: data }, { new: true }) : await DeliveryProviderAccount.create(data);
  if (!account) throw new AppError(404, "Account not found");
  return { accountId: String(account._id), provider: account.provider, name: account.name, cities: account.cities, kitchenIds: account.kitchens.map(String), isActive: account.isActive };
}

/** Live rider position (kitchen riders or a partner webhook) to track:location. */
export async function updateRiderLocation(kitchenId, orderId, { lat, lng, heading = null, speed = null }) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), kitchen: kitchenId }).select("deliveryJob status").lean();
  if (!order?.deliveryJob) throw new AppError(404, "No delivery for this order");
  if (order.status !== "dispatched") throw new AppError(409, "Location is shared while the order is out for delivery");
  const job = await DeliveryJob.findById(order.deliveryJob);
  await updateJob(job, { location: { lat, lng, heading, speed }, by: "kitchen" });
  return { updated: true };
}

/** Kitchen console actions on its own orders' deliveries. */
export async function kitchenDeliveryAction(kitchenId, orderId, { action, rider, provider, reason }) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), kitchen: kitchenId });
  if (!order) throw new AppError(404, "Order not found");
  if (action === "book" || action === "rebook") {
    if (action === "rebook" && order.deliveryJob) {
      const current = await DeliveryJob.findById(order.deliveryJob);
      if (current && !["cancelled", "failed", "delivered"].includes(current.status)) await cancelJob(current, { reason: reason || "Re-booked by kitchen", by: "kitchen" });
    }
    return toJob(await bookForOrder(order._id, { by: "kitchen", provider: provider || null }));
  }
  let job = order.deliveryJob ? await DeliveryJob.findById(order.deliveryJob) : null;
  if (!job) job = await bookForOrder(order._id, { by: "kitchen" });
  const managed = getProvider(job.provider).managedByKitchen;
  if (!managed && ["assign_rider", "picked_up", "delivered"].includes(action)) throw new AppError(409, "This delivery is run by the delivery partner");
  if (action === "assign_rider") {
    if (!rider?.name) throw new AppError(422, "Rider name is required");
    return toJob(await updateJob(job, { rider, by: "kitchen" }));
  }
  if (action === "picked_up") return toJob(await updateJob(job, { status: "picked_up", by: "kitchen" }));
  if (action === "delivered") return toJob(await updateJob(job, { status: "delivered", by: "kitchen" }));
  if (action === "cancel") return toJob(await cancelJob(job, { reason: reason || "Cancelled by kitchen", by: "kitchen" }));
  throw new AppError(422, "Unknown delivery action");
}

/** Called on order transitions: books automatically when the settings say so. */
export async function onOrderStatus({ orderId, to, kitchenId }) {
  if (!["accepted", "ready"].includes(to)) return;
  const settings = await deliverySettings(kitchenId);
  if (!settings.autoBook) return;
  const order = await Order.findById(orderId).select("deliveryMode deliveryJob status").lean();
  if (!order || order.deliveryMode === "pickup") return;
  if (to === settings.bookAt || (to === "ready" && !order.deliveryJob)) {
    if (to === "accepted" && settings.bookOffsetMinutes > 0) return; // the delivery watchdog books after the offset
    await bookForOrder(orderId, { by: "system" });
  }
}

/** Every minute: books jobs whose accept offset has passed and retries failed bookings. */
export async function deliveryWatchdog() {
  let booked = 0;
  const waiting = await Order.find({ status: { $in: ["accepted", "preparing"] }, deliveryMode: "delivery", deliveryJob: null }).limit(200).lean();
  for (const order of waiting) {
    const settings = await deliverySettings(order.kitchen);
    if (!settings.autoBook || settings.bookAt !== "accepted") continue;
    if (Date.now() - new Date(order.acceptedAt).getTime() < settings.bookOffsetMinutes * 60_000) continue;
    await bookForOrder(order._id).catch(() => {});
    booked += 1;
  }
  const failed = await DeliveryJob.find({ status: "failed", order: { $ne: null }, updatedAt: { $lte: new Date(Date.now() - 2 * 60_000) } }).limit(100);
  for (const job of failed) {
    const settings = await deliverySettings(job.kitchen);
    if (job.attempts > settings.rebookAttempts) continue;
    await bookForOrder(job.order).catch(() => {});
    booked += 1;
  }
  return booked;
}

// ---- admin

export async function listJobs({ status, kitchenId, provider, from, to, page = 1, limit = 25 }) {
  const filter = {};
  if (status) filter.status = status;
  if (kitchenId) filter.kitchen = objectId(kitchenId, "kitchen ID");
  if (provider) filter.provider = provider;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const [items, total] = await Promise.all([
    DeliveryJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("order", "orderNumber").populate("kitchen", "name").lean(),
    DeliveryJob.countDocuments(filter),
  ]);
  return { items: items.map(toJob), page, limit, total };
}

export async function adminJobAction(jobId, { action, rider, reason, costPaise }) {
  const job = await DeliveryJob.findById(objectId(jobId, "job ID"));
  if (!job) throw new AppError(404, "Delivery not found");
  if (action === "rebook" && job.order) {
    if (!["cancelled", "failed", "delivered"].includes(job.status)) await cancelJob(job, { reason: reason || "Re-booked by MealJi", by: "admin" });
    return toJob(await bookForOrder(job.order, { by: "admin" }));
  }
  if (action === "cancel") return toJob(await cancelJob(job, { reason: reason || "Cancelled by MealJi", by: "admin" }));
  if (action === "assign_rider") return toJob(await updateJob(job, { rider, by: "admin" }));
  if (action === "picked_up" || action === "delivered") return toJob(await updateJob(job, { status: action, by: "admin" }));
  if (action === "set_cost") return toJob(await updateJob(job, { costPaise, by: "admin" }));
  throw new AppError(422, "Unknown delivery action");
}

export async function providerOverview() {
  const accounts = await DeliveryProviderAccount.find().lean();
  return {
    providers: listProviders(),
    accounts: accounts.map((account) => ({ accountId: String(account._id), provider: account.provider, name: account.name, cities: account.cities, kitchenIds: (account.kitchens || []).map(String), isActive: account.isActive })),
  };
}

/** Provider webhooks (3PL). Unknown providers are ignored. */
export async function handleProviderWebhook(providerKey, body, headers) {
  const adapter = getProvider(providerKey);
  if (adapter.key !== providerKey) return { ignored: true };
  const update = adapter.parseWebhook(body, headers);
  if (!update?.providerJobId) return { ignored: true };
  const job = await DeliveryJob.findOne({ provider: providerKey, providerJobId: update.providerJobId });
  if (!job) return { ignored: true };
  await updateJob(job, { ...update, by: providerKey });
  return { processed: true };
}
