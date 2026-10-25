import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { maskPhone } from "../../common/phone.util.js";
import { istDateKey, istDateTime } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { publish } from "../../realtime/hub.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { Order } from "../order/order.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { DeliveryJob, DeliveryProviderAccount } from "./delivery.model.js";
import { getProvider, listProviders } from "./providers.js";
import { riderCard } from "./rider.view.js";
import { shippingConfigured } from "./shipping.provider.js";

const OPEN = ["pending", "booked", "assigned", "picked_up"];
const CLOSED = ["cancelled", "delivered"];
const RIDER_NONE = { name: null, phone: null, vehicleNumber: null, photoUrl: null, rating: null, deliveriesCount: null, phoneMasked: null, vehicleType: null, externalId: null };

export function toJob(job) {
  const meal = job.mealDrop?.date ? job.mealDrop : null;
  return {
    jobId: String(job._id),
    kind: job.mealDrop ? "meal" : "order",
    orderId: job.order ? String(job.order._id || job.order) : null,
    orderNumber: job.order?.orderNumber || null,
    mealDropId: job.mealDrop ? String(job.mealDrop._id || job.mealDrop) : null,
    // Admin list: which plan meal this is (“Lunch · 2026-10-24”).
    meal: meal ? { date: meal.date, slot: meal.slot, userId: meal.user ? String(meal.user) : null } : null,
    kitchenId: String(job.kitchen?._id || job.kitchen),
    kitchenName: job.kitchen?.name || null,
    provider: job.provider,
    providerJobId: job.providerJobId,
    providerSubStatus: job.providerSubStatus || null,
    status: job.status,
    quotePaise: job.quotePaise,
    costPaise: job.costPaise,
    rider: job.rider?.name
      ? { name: job.rider.name, phone: job.rider.phone, phoneMasked: job.rider.phoneMasked || (job.rider.phone ? maskPhone(job.rider.phone) : null), vehicleNumber: job.rider.vehicleNumber, vehicleType: job.rider.vehicleType || null }
      : null,
    trackingUrl: job.trackingUrl,
    attempts: job.attempts,
    failureReason: job.failureReason,
    gaveUpAt: job.gaveUpAt || null,
    eta: job.eta || null,
    bookedAt: job.bookedAt,
    pickedUpAt: job.pickedUpAt,
    deliveredAt: job.deliveredAt,
    lastLocation: job.lastLocation?.lat != null ? job.lastLocation : null,
    history: job.history || [],
    createdAt: job.createdAt,
  };
}

/** True while the customer may ring the rider through the partner (on the way, or bringing a failed delivery back). */
export function riderCallable(job) {
  if (!job || !getProvider(job.provider).callRider || getProvider(job.provider).key !== job.provider) return false;
  if (["assigned", "picked_up"].includes(job.status)) return true;
  return job.status === "failed" && Boolean(job.pickedUpAt) && ["delivery_failed", "returning"].includes(job.providerSubStatus);
}

/** A live delivery run by a partner (not the kitchen): kitchen staff must not move it by hand. */
export async function partnerRunsDelivery(jobId) {
  if (!jobId) return false;
  const job = await DeliveryJob.findById(jobId).select("provider status").lean();
  return Boolean(job && OPEN.includes(job.status) && !getProvider(job.provider).managedByKitchen);
}

async function deliverySettings(kitchenId) {
  return (await resolveSetting("delivery", { kitchenId })).values;
}

/** Who delivers subscription meals ("Meal drops are delivered by", in the subscription policy). */
export async function mealDropProviderFor(kitchenId) {
  return (await resolveSetting("subscription_policy", { kitchenId })).values.mealDropProvider || "manual";
}

function opsAlert(kitchenId, data) {
  const alert = { ...data, kitchenId: kitchenId ? String(kitchenId) : null, at: new Date().toISOString() };
  publish("admin:ops", "delivery:alert", alert);
  if (kitchenId) publish(`kitchen:${kitchenId}`, "delivery:alert", alert);
}

const kitchenPickup = (kitchen) => ({ latitude: kitchen.latitude, longitude: kitchen.longitude, address: [kitchen.addressLine, kitchen.area, kitchen.city].filter(Boolean).join(", ") });

/** Picks the adapter for a booking: the explicit one, the setting (`field`), or the best quote. */
async function adapterFor(kitchen, address, settings, provider, field = "provider") {
  let key = provider || settings[field];
  if (key === "self" && !settings.selfDeliveryAllowed && provider) throw new AppError(403, "Self delivery is not allowed for this kitchen");
  if (key === "auto") key = await chooseProvider(kitchen, { address }, settings.autoSelect);
  return getProvider(key);
}

function orderContext(order, kitchen) {
  const cod = order.paymentMethod === "cod" && order.paymentStatus === "cod_pending";
  return {
    reference: order.orderNumber,
    recipient: { name: order.address?.recipientName || order.customer?.name, phone: order.address?.phone || order.customer?.phone },
    codPaise: cod ? (order.bill?.grandTotalPaise ?? 0) : 0,
    deliverBy: order.estimatedDeliveryAt,
    kitchen,
  };
}

async function mealContext(meal, kitchen) {
  const { MealSlot, Subscription } = await import("../subscription/subscription.model.js");
  const [slot, sub] = await Promise.all([
    MealSlot.findOne({ kitchen: meal.kitchen, key: meal.slot }).lean(),
    meal.address ? null : Subscription.findById(meal.subscription).select("address").lean(),
  ]);
  const address = meal.address || sub?.address || {};
  let user = null;
  if (!address.phone || !address.recipientName) {
    const { User } = await import("../user/user.model.js");
    user = await User.findById(meal.user).select("name phoneNumber").lean();
  }
  return {
    address,
    slot,
    context: {
      reference: `meal ${meal.date} ${meal.slot} ${String(meal._id).slice(-6)}`,
      recipient: { name: address.recipientName || user?.name, phone: address.phone || user?.phoneNumber },
      deliverBy: slot?.windowEnd ? istDateTime(meal.date, slot.windowEnd) : null,
      kitchen,
    },
  };
}

/** The booking context of an existing job (to replay it after a timeout or a crash). */
async function contextFor(job) {
  const kitchen = await Kitchen.findById(job.kitchen).lean();
  if (job.order) {
    const order = await Order.findById(job.order).lean();
    return order ? orderContext(order, kitchen) : null;
  }
  const { MealSelection } = await import("../subscription/subscription.model.js");
  const meal = await MealSelection.findById(job.mealDrop).lean();
  return meal ? (await mealContext(meal, kitchen)).context : null;
}

/**
 * Books a claimed job with the partner. The exact request is saved first, so a
 * timeout or a crash can be replayed with the same idempotency key (the job id)
 * and never creates a second delivery. A partner that may have accepted the
 * call (timeout, 5xx) leaves the job `bookingUncertain`: it is retried as the
 * same job, never re-booked as a new one.
 */
async function callPartner(job, adapter, context, by) {
  if (adapter.requestFor && !job.providerRequest) {
    job.providerRequest = adapter.requestFor(job, context);
    await job.save();
  }
  try {
    if (!adapter.quoteOnCreate) {
      const quote = await adapter.quote({ pickup: job.pickup, drop: job.drop });
      if (quote) job.quotePaise = quote.pricePaise;
    }
    const created = await adapter.create(job, context);
    job.providerJobId = created.providerJobId;
    job.status = created.status || "booked";
    job.trackingUrl = created.trackingUrl || null;
    if (created.costPaise != null) job.costPaise = created.costPaise;
    if (adapter.quoteOnCreate && created.costPaise != null && job.quotePaise == null) job.quotePaise = created.costPaise;
    job.deliveryOtp = created.deliveryOtp || null;
    job.bookingUncertain = false;
    job.failureReason = null;
    job.bookedAt = new Date();
    job.history.push({ status: job.status, at: new Date(), by });
  } catch (err) {
    job.status = "failed";
    job.failureReason = err.message;
    job.bookingUncertain = Boolean(err.transient);
    job.history.push({ status: "failed", at: new Date(), note: err.message, by });
    logger.warn({ err: err.message, jobId: String(job._id), transient: Boolean(err.transient) }, "Delivery booking failed");
  }
  await job.save();
}

async function announceBooking(job, by) {
  await publishEventSafe(job.status === "failed" ? "delivery.booking_failed" : "delivery.booked", { jobId: String(job._id), orderId: job.order ? String(job.order) : null, mealId: job.mealDrop ? String(job.mealDrop) : null, provider: job.provider, by });
  publish(`kitchen:${job.kitchen}`, "kitchen:delivery_updated", toJob(job));
}

/** Retries the same job (same idempotency key): after a timeout, or a booking left pending by a crash. */
async function resumeJob(job, by = "system") {
  const context = await contextFor(job);
  if (!context) return job;
  job.attempts += 1;
  job.status = "pending";
  job.history.push({ status: "pending", at: new Date(), note: "Retrying the same booking", by });
  await job.save();
  await callPartner(job, getProvider(job.provider), context, by);
  await announceBooking(job, by);
  return job;
}

/** The failed job a new booking replaces: closed, so it is never retried again. */
async function supersede(existing, by) {
  if (existing?.status !== "failed") return;
  await DeliveryJob.updateOne({ _id: existing._id, status: "failed" }, { $set: { status: "cancelled" }, $push: { history: { status: "cancelled", at: new Date(), note: "Re-booked", by } } });
}

/** Books a delivery for an order with the kitchen's configured provider. */
export async function bookForOrder(orderId, { by = "system", provider = null } = {}) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError(404, "Order not found");
  if (order.deliveryMode === "pickup") throw new AppError(409, "Pickup orders are not delivered");
  if (CLOSED.includes(order.status)) throw new AppError(409, "This order is closed");
  const existing = order.deliveryJob ? await DeliveryJob.findById(order.deliveryJob) : null;
  if (existing && !["cancelled", "failed"].includes(existing.status)) return existing;
  // The partner may already hold this booking: replay it rather than book a second rider.
  if (existing?.status === "failed" && existing.bookingUncertain && (!provider || provider === existing.provider)) return resumeJob(existing, by);

  const settings = await deliverySettings(order.kitchen);
  const kitchen = await Kitchen.findById(order.kitchen).lean();
  const adapter = await adapterFor(kitchen, order.address, settings, provider);
  const job = new DeliveryJob({
    order: order._id,
    kitchen: order.kitchen,
    provider: adapter.key,
    status: "pending",
    pickup: kitchenPickup(kitchen),
    drop: { latitude: order.address?.latitude, longitude: order.address?.longitude, address: order.address?.fullAddress },
    attempts: existing ? existing.attempts + 1 : 1,
    history: [{ status: "pending", at: new Date(), by }],
  });
  // Claim the booking before calling the partner: only the caller that swaps the
  // order's job (none / the failed one → this one) books. The auto-book event,
  // the watchdog and a replayed event can no longer book two riders.
  await job.save();
  const claim = await Order.updateOne(
    { _id: order._id, deliveryJob: existing ? existing._id : null, status: { $nin: CLOSED } },
    { $set: { deliveryJob: job._id } },
  );
  if (!claim.modifiedCount) {
    await DeliveryJob.deleteOne({ _id: job._id });
    const current = await Order.findById(order._id).select("deliveryJob status").lean();
    if (CLOSED.includes(current?.status)) throw new AppError(409, "This order is closed");
    return current?.deliveryJob ? DeliveryJob.findById(current.deliveryJob) : null;
  }
  await supersede(existing, by);
  await callPartner(job, adapter, orderContext(order, kitchen), by);
  await announceBooking(job, by);
  return job;
}

/**
 * Books the delivery of one subscription meal (a "meal drop": plan × date ×
 * slot), prepaid, to arrive by the end of the slot's window, with the partner
 * set in "Meal drops are delivered by". Same claim rule as orders.
 */
export async function bookForMeal(mealId, { by = "system", provider = null } = {}) {
  const { MealSelection } = await import("../subscription/subscription.model.js");
  const meal = await MealSelection.findById(mealId);
  if (!meal) throw new AppError(404, "Meal not found");
  if (!["selected", "locked"].includes(meal.status)) throw new AppError(409, "Only confirmed meals that have not left the kitchen can be booked");
  const existing = meal.deliveryJob ? await DeliveryJob.findById(meal.deliveryJob) : null;
  if (existing && !["cancelled", "failed"].includes(existing.status)) return existing;
  if (existing?.status === "failed" && existing.bookingUncertain && (!provider || provider === existing.provider)) return resumeJob(existing, by);

  const [delivery, mealDropProvider, kitchen] = await Promise.all([deliverySettings(meal.kitchen), mealDropProviderFor(meal.kitchen), Kitchen.findById(meal.kitchen).lean()]);
  const settings = { ...delivery, mealDropProvider };
  const { address, context } = await mealContext(meal.toObject(), kitchen);
  const adapter = await adapterFor(kitchen, address, settings, provider, "mealDropProvider");
  const job = new DeliveryJob({
    mealDrop: meal._id,
    kitchen: meal.kitchen,
    provider: adapter.key,
    status: "pending",
    pickup: kitchenPickup(kitchen),
    drop: { latitude: address.latitude, longitude: address.longitude, address: address.fullAddress },
    attempts: existing ? existing.attempts + 1 : 1,
    history: [{ status: "pending", at: new Date(), by }],
  });
  await job.save();
  const claim = await MealSelection.updateOne(
    { _id: meal._id, deliveryJob: existing ? existing._id : null, status: { $in: ["selected", "locked"] } },
    { $set: { deliveryJob: job._id } },
  );
  if (!claim.modifiedCount) {
    await DeliveryJob.deleteOne({ _id: job._id });
    const current = await MealSelection.findById(meal._id).select("deliveryJob").lean();
    return current?.deliveryJob ? DeliveryJob.findById(current.deliveryJob) : null;
  }
  await supersede(existing, by);
  await callPartner(job, adapter, context, by);
  await announceBooking(job, by);
  return job;
}

/** Runs `fn` over `items` a few at a time, stopping new work once `budgetMs` is spent (the rest waits for the next run). */
async function inBatches(items, fn, { concurrency = 5, budgetMs = 45_000 } = {}) {
  const until = Date.now() + budgetMs;
  for (let i = 0; i < items.length && Date.now() < until; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map((item) => fn(item).catch((err) => logger.warn({ err: err.message }, "Delivery batch item failed"))));
  }
}

/**
 * Every minute: books the drops of today's confirmed meals a few minutes before
 * their slot's dispatch time (kitchens whose meal drops go to a partner), until
 * the slot's window ends, and retries failed drops.
 */
export async function mealDeliveryRun() {
  const { MealSelection, MealSlot } = await import("../subscription/subscription.model.js");
  const today = istDateKey();
  let booked = 0;
  const slots = await MealSlot.find({ isActive: true }).lean();
  for (const slot of slots) {
    const settings = await deliverySettings(slot.kitchen);
    if (!settings.autoBook || ["manual", "self"].includes(await mealDropProviderFor(slot.kitchen))) continue;
    const now = Date.now();
    if (now < istDateTime(today, slot.dispatchTime).getTime() - settings.mealBookLeadMinutes * 60_000) continue;
    // Too late for this slot (e.g. after a restart): a rider hours late helps nobody.
    if (now > istDateTime(today, slot.windowEnd).getTime()) continue;
    const meals = await MealSelection.find({ kitchen: slot.kitchen, slot: slot.key, date: today, status: { $in: ["selected", "locked"] }, deliveryJob: null }).select("_id").limit(500).lean();
    await inBatches(meals, async (meal) => {
      const job = await bookForMeal(meal._id);
      if (job && job.status !== "failed") booked += 1;
    });
  }
  booked += await retryFailed("mealDrop");
  return booked;
}

/**
 * Failed bookings (before pickup) of open orders or meals: the current job is
 * re-booked (or replayed when the partner may hold it) until the attempts set
 * in "Re-book attempts" are used; then ops are alerted once. Jobs of closed
 * orders or meals, and jobs already replaced, are closed.
 */
async function retryFailed(kind) {
  const { MealSelection } = await import("../subscription/subscription.model.js");
  const today = istDateKey();
  let booked = 0;
  const failed = await DeliveryJob.find({ status: "failed", [kind]: { $ne: null }, pickedUpAt: null, gaveUpAt: null, updatedAt: { $lte: new Date(Date.now() - 2 * 60_000) } }).sort({ updatedAt: 1 }).limit(100);
  for (const job of failed) {
    const target = kind === "order" ? await Order.findById(job.order).select("status deliveryJob orderNumber").lean() : await MealSelection.findById(job.mealDrop).select("status date deliveryJob").lean();
    const open = kind === "order" ? target && !CLOSED.includes(target.status) : target && ["selected", "locked"].includes(target.status) && target.date === today;
    if (!open || String(target.deliveryJob) !== String(job._id)) {
      await DeliveryJob.updateOne({ _id: job._id, status: "failed" }, { $set: { status: "cancelled" }, $push: { history: { status: "cancelled", at: new Date(), note: open ? "Re-booked" : kind === "order" ? "Order closed" : "Meal closed", by: "system" } } });
      continue;
    }
    const settings = await deliverySettings(job.kitchen);
    if (job.attempts > settings.rebookAttempts) {
      await DeliveryJob.updateOne({ _id: job._id, gaveUpAt: null }, { $set: { gaveUpAt: new Date() } });
      await publishEventSafe("delivery.gave_up", { jobId: String(job._id), orderId: job.order ? String(job.order) : null, mealId: job.mealDrop ? String(job.mealDrop) : null, kitchenId: String(job.kitchen), reason: job.failureReason });
      opsAlert(job.kitchen, { type: "booking_gave_up", jobId: String(job._id), orderId: job.order ? String(job.order) : null, orderNumber: target.orderNumber || null, mealId: job.mealDrop ? String(job.mealDrop) : null, reason: job.failureReason, attempts: job.attempts });
      continue;
    }
    // A retry stays with the provider the failed booking was made with (the kitchen may have chosen it).
    const next = await (job.bookingUncertain ? resumeJob(job) : kind === "order" ? bookForOrder(job.order, { provider: job.provider }) : bookForMeal(job.mealDrop, { provider: job.provider })).catch(() => null);
    if (next && next.status !== "failed") booked += 1;
  }
  return booked;
}

/** Bookings left `pending` (the process stopped mid-call): replayed with the same key. */
async function redrivePending() {
  const stuck = await DeliveryJob.find({ status: "pending", updatedAt: { $lte: new Date(Date.now() - 5 * 60_000) } }).sort({ updatedAt: 1 }).limit(50);
  for (const job of stuck) {
    job.bookingUncertain = true;
    await resumeJob(job).catch((err) => logger.warn({ err: err.message, jobId: String(job._id) }, "Pending delivery not replayed"));
  }
}

/**
 * Applies a delivery change (kitchen action for manual/self jobs, admin, or a
 * provider webhook) to the job, then to its order or meal. The job is saved
 * first and everything else follows, so a save refused by a condition (a newer
 * provider event, see handleProviderWebhook) leaves no trace.
 */
export async function updateJob(job, { status, rider = null, clearRider = false, subStatus = null, eta = null, remainingDistanceM = null, costPaise = null, location = null, note = null, pickedUp = false, by = "system" }) {
  let riderChanged = false;
  let riderCleared = false;
  if (rider?.name) {
    const rating = Number(rider.rating);
    const deliveries = Number(rider.deliveriesCount);
    riderChanged = job.rider?.name !== rider.name || (job.rider?.externalId || null) !== (rider.externalId || null);
    job.rider = {
      name: rider.name,
      phone: rider.phone || null,
      vehicleNumber: rider.vehicleNumber || null,
      photoUrl: rider.photoUrl || null,
      rating: Number.isFinite(rating) && rating > 0 ? Math.min(5, Math.round(rating * 10) / 10) : null,
      deliveriesCount: Number.isInteger(deliveries) && deliveries >= 0 ? deliveries : null,
      phoneMasked: rider.phoneMasked || null,
      vehicleType: rider.vehicleType || null,
      externalId: rider.externalId || null,
    };
    if (status == null && job.status === "booked") status = "assigned";
  } else if (clearRider && job.rider?.name) {
    // The rider handed the delivery back: nobody is assigned until the next one accepts.
    job.rider = { ...RIDER_NONE };
    riderCleared = true;
  }
  if (subStatus) job.providerSubStatus = subStatus;
  if (eta) job.eta = new Date(eta);
  if (remainingDistanceM != null) job.remainingDistanceM = remainingDistanceM;
  if (costPaise != null) job.costPaise = costPaise;
  if (location) job.lastLocation = { ...location, at: new Date() };
  if (pickedUp && !job.pickedUpAt) job.pickedUpAt = new Date();
  const statusChanged = Boolean(status && status !== job.status);
  if (statusChanged) {
    job.status = status;
    job.history.push({ status, at: new Date(), note, by });
    if (status === "picked_up" && !job.pickedUpAt) job.pickedUpAt = new Date();
    if (status === "delivered") job.deliveredAt = new Date();
    if (status === "failed" && note) job.failureReason = note;
  }
  await job.save();
  if (statusChanged) {
    await publishEventSafe(`delivery.${status}`, {
      jobId: String(job._id),
      orderId: job.order ? String(job.order) : null,
      mealId: job.mealDrop ? String(job.mealDrop) : null,
      kitchenId: String(job.kitchen),
      pickedUp: Boolean(job.pickedUpAt),
      reason: job.failureReason || null,
      subStatus: job.providerSubStatus || null,
    });
  }
  await syncTargets(job, { status, riderChanged, riderCleared, location, by });
  publish(`kitchen:${job.kitchen}`, "kitchen:delivery_updated", toJob(job));
  return job;
}

/**
 * The order or meal follows its delivery (idempotent, also used to finish a
 * sync that failed half way): picked up → ready (if the kitchen forgot) →
 * dispatched / out for delivery; delivered → delivered. Rider and position go
 * to the customer's screens.
 */
async function syncTargets(job, { status, riderChanged = false, riderCleared = false, location = null, by = "system" }) {
  const etaFields = { eta: job.eta ? new Date(job.eta).toISOString() : null, remainingDistanceM: job.remainingDistanceM ?? null };
  if (job.order) {
    const { transition } = await import("../order/order.service.js");
    let order = await Order.findById(job.order);
    if (!order) return;
    if (riderChanged || riderCleared) {
      order.rider = riderCleared ? { ...RIDER_NONE } : job.rider;
      await order.save();
      const room = `order:${order._id}`;
      if (riderCleared) publish(room, "order:rider_unassigned", { orderId: String(order._id) });
      else publish(room, "order:rider_assigned", { orderId: String(order._id), rider: riderCard(job.rider, { onTheWay: order.status === "dispatched" }), canCallRider: riderCallable(job) });
    }
    if (location) publish(`order:${order._id}`, "track:location", { orderId: String(order._id), lat: location.lat, lng: location.lng, heading: location.heading ?? null, speed: location.speed ?? null, ...etaFields, updatedAt: new Date().toISOString() });
    const actor = by === "kitchen" ? "kitchen" : by === "admin" ? "admin" : "system";
    if (status === "picked_up" || status === "delivered") {
      if (["accepted", "preparing"].includes(order.status)) order = await transition(order._id, "ready", { actor, note: "Rider picked up" });
      if (order.status === "ready") order = await transition(order._id, "dispatched", { actor, note: "Rider picked up" });
    }
    if (status === "delivered" && order.status === "dispatched") await transition(order._id, "delivered", { actor, note: "Delivered" });
  }
  if (job.mealDrop) {
    const { MealSelection } = await import("../subscription/subscription.model.js");
    const { kitchenMealAction } = await import("../subscription/mealplan.service.js");
    const meal = await MealSelection.findById(job.mealDrop).select("user status date slot").lean();
    if (!meal) return;
    const room = `user:${meal.user}`;
    const base = { mealId: String(meal._id), date: meal.date, slot: meal.slot };
    if (riderCleared) publish(room, "meal:rider_unassigned", base);
    else if (riderChanged) publish(room, "meal:rider_assigned", { ...base, rider: riderCard(job.rider, { onTheWay: meal.status === "out_for_delivery" }), canCallRider: riderCallable(job) });
    if (location) publish(room, "meal:location", { ...base, lat: location.lat, lng: location.lng, heading: location.heading ?? null, speed: location.speed ?? null, ...etaFields, updatedAt: new Date().toISOString() });
    if ((status === "picked_up" || status === "delivered") && ["selected", "locked"].includes(meal.status)) await kitchenMealAction(job.kitchen, meal._id, "dispatch", { fromPartner: true });
    if (status === "delivered" && meal.status !== "delivered") await kitchenMealAction(job.kitchen, meal._id, "deliver", { fromPartner: true });
  }
}

/**
 * Cancels a delivery with its partner first: the job is closed only once the
 * partner confirms (a partner that cannot be reached, or a rider who already
 * has the food, leaves it open and the caller gets the reason).
 */
export async function cancelJob(job, { reason, by }) {
  if (CLOSED.includes(job.status)) return job;
  if (job.status === "pending") throw new AppError(409, "The rider is being booked right now. Try again in a minute.");
  const adapter = getProvider(job.provider);
  if (!adapter.managedByKitchen && job.pickedUpAt) throw new AppError(409, "The rider already has the food, so this delivery can't be cancelled");
  if (job.providerJobId) await adapter.cancel(job);
  return updateJob(job, { status: "cancelled", note: reason, by });
}

/** order.cancelled: the rider is called off (retried by the event bus while the partner is unreachable). */
export async function onOrderCancelled({ orderId }) {
  const order = await Order.findById(orderId).select("deliveryJob orderNumber kitchen").lean();
  const job = order?.deliveryJob ? await DeliveryJob.findById(order.deliveryJob) : null;
  if (!job || CLOSED.includes(job.status)) return;
  if (job.status === "pending") throw new Error("Delivery booking in progress; retry the cancellation");
  if (job.status === "failed" && !job.providerJobId) {
    await updateJob(job, { status: "cancelled", note: "Order cancelled", by: "system" });
    return;
  }
  try {
    await cancelJob(job, { reason: "Order cancelled", by: "system" });
  } catch (err) {
    if (err.statusCode !== 409) throw err;
    // The rider already has the food: ops arrange the return.
    opsAlert(order.kitchen, { type: "cancelled_after_pickup", jobId: String(job._id), orderId: String(orderId), orderNumber: order.orderNumber, message: err.message });
  }
}

/** delivery.failed after pickup, or re-booking given up: tell the customer and ops (the order stays open for ops to settle). */
export async function onDeliveryProblem(event) {
  const { jobId, orderId, mealId, pickedUp } = event.payload;
  if (event.name === "delivery.failed" && !pickedUp) return; // before pickup the watchdog re-books
  const { notify } = await import("../notification/notification.service.js");
  // Gave up before pickup: the food is still at the kitchen, nobody tried to deliver it yet.
  const gaveUp = event.name === "delivery.gave_up";
  if (orderId) {
    const order = await Order.findById(orderId).select("user orderNumber kitchen").lean();
    if (!order) return;
    await notify({ userId: order.user, templateKey: gaveUp ? "order.delivery_delayed" : "order.delivery_failed", data: { order: { orderId: String(order._id), orderNumber: order.orderNumber } }, dedupeKey: `delivery:${jobId}:problem` });
    if (event.name === "delivery.failed") opsAlert(order.kitchen, { type: "delivery_failed", jobId, orderId, orderNumber: order.orderNumber, reason: event.payload.reason, subStatus: event.payload.subStatus });
  } else if (mealId) {
    const { MealSelection } = await import("../subscription/subscription.model.js");
    const meal = await MealSelection.findById(mealId).select("user slot date kitchen").lean();
    if (!meal) return;
    await notify({ userId: meal.user, templateKey: gaveUp ? "meal.delivery_delayed" : "meal.delivery_failed", data: { meal: { slotName: meal.slot, date: meal.date } }, dedupeKey: `delivery:${jobId}:problem` });
    if (event.name === "delivery.failed") opsAlert(meal.kitchen, { type: "delivery_failed", jobId, mealId, reason: event.payload.reason, subStatus: event.payload.subStatus });
  }
}

/**
 * Multi-provider selection (Phase 5): asks every active partner account that
 * covers the kitchen for a quote and picks the cheapest (or the fastest
 * pickup). A partner with no rider free gives no quote. Falls back to the
 * manual provider when no partner answers.
 */
export async function chooseProvider(kitchen, order, prefer = "cheapest") {
  const accounts = await DeliveryProviderAccount.find({ isActive: true }).lean();
  const city = String(kitchen.city || "").toLowerCase();
  const eligible = accounts.filter((account) => (!account.kitchens?.length || account.kitchens.map(String).includes(String(kitchen._id))) && (!account.cities?.length || account.cities.includes(city)));
  // Our own platform needs no partner account: it competes everywhere unless an
  // account for it exists (then that account's cities, kitchens and on/off apply).
  if (shippingConfigured() && !(await DeliveryProviderAccount.exists({ provider: "shipping" }))) eligible.push({ provider: "shipping" });
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
  if (!job) throw new AppError(404, "No delivery for this order");
  // The order is out for delivery, so a kitchen rider has the food: the position is shown
  // only for picked-up jobs, so a job the kitchen didn't mark picked up catches up here.
  const catchUp = getProvider(job.provider).managedByKitchen && ["booked", "assigned"].includes(job.status);
  await updateJob(job, { location: { lat, lng, heading, speed }, ...(catchUp ? { status: "picked_up" } : {}), by: "kitchen" });
  return { updated: true };
}

/** Kitchen console actions on its own orders' deliveries. */
export async function kitchenDeliveryAction(kitchenId, orderId, { action, rider, provider, reason }) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), kitchen: kitchenId });
  if (!order) throw new AppError(404, "Order not found");
  if (action === "book" || action === "rebook") {
    if (action === "rebook" && order.deliveryJob) {
      const current = await DeliveryJob.findById(order.deliveryJob);
      if (current && OPEN.includes(current.status)) await cancelJob(current, { reason: reason || "Re-booked by kitchen", by: "kitchen" });
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

/** Kitchen console: book, re-book or cancel the delivery of one of its subscription meals. */
export async function kitchenMealDeliveryAction(kitchenId, mealId, { action, provider, reason }) {
  const { MealSelection } = await import("../subscription/subscription.model.js");
  const meal = await MealSelection.findOne({ _id: objectId(mealId, "meal ID"), kitchen: kitchenId }).select("deliveryJob").lean();
  if (!meal) throw new AppError(404, "Meal not found");
  const current = meal.deliveryJob ? await DeliveryJob.findById(meal.deliveryJob) : null;
  if (action === "cancel") {
    if (!current) throw new AppError(404, "No delivery for this meal");
    return toJob(await cancelJob(current, { reason: reason || "Cancelled by kitchen", by: "kitchen" }));
  }
  if (action === "rebook" && current && OPEN.includes(current.status)) await cancelJob(current, { reason: reason || "Re-booked by kitchen", by: "kitchen" });
  return toJob(await bookForMeal(meal._id, { by: "kitchen", provider: provider || null }));
}

/** Called on order transitions: books automatically when the settings say so. */
export async function onOrderStatus({ orderId, to, kitchenId }) {
  if (!["accepted", "ready"].includes(to)) return;
  const settings = await deliverySettings(kitchenId);
  if (!settings.autoBook) return;
  const order = await Order.findById(orderId).select("deliveryMode deliveryJob status").lean();
  // The order may have closed before this queued event ran: nothing to book (not an error to retry).
  if (!order || order.deliveryMode === "pickup" || CLOSED.includes(order.status)) return;
  if (to === settings.bookAt || (to === "ready" && !order.deliveryJob)) {
    if (to === "accepted" && settings.bookOffsetMinutes > 0) return; // the delivery watchdog books after the offset
    await bookForOrder(orderId, { by: "system" });
  }
}

/** Every minute: books jobs whose accept offset has passed, retries failed bookings and replays stuck ones. */
export async function deliveryWatchdog() {
  let booked = 0;
  const waiting = await Order.find({ status: { $in: ["accepted", "preparing"] }, deliveryMode: "delivery", deliveryJob: null }).limit(200).lean();
  const due = [];
  for (const order of waiting) {
    const settings = await deliverySettings(order.kitchen);
    if (!settings.autoBook || settings.bookAt !== "accepted") continue;
    if (Date.now() - new Date(order.acceptedAt).getTime() < settings.bookOffsetMinutes * 60_000) continue;
    due.push(order);
  }
  await inBatches(due, async (order) => {
    const job = await bookForOrder(order._id);
    if (job && job.status !== "failed") booked += 1;
  });
  // A delivery that failed after pickup is not re-booked: the food left the kitchen (ops decide).
  booked += await retryFailed("order");
  await redrivePending();
  return booked;
}

// ---- admin

export async function listJobs({ status, kitchenId, provider, kind, from, to, page = 1, limit = 25 }) {
  const filter = {};
  if (status) filter.status = status;
  if (kitchenId) filter.kitchen = objectId(kitchenId, "kitchen ID");
  if (provider) filter.provider = provider;
  if (kind === "order") filter.order = { $ne: null };
  if (kind === "meal") filter.mealDrop = { $ne: null };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const [items, total] = await Promise.all([
    DeliveryJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("order", "orderNumber").populate("mealDrop", "date slot user").populate("kitchen", "name").lean(),
    DeliveryJob.countDocuments(filter),
  ]);
  return { items: items.map(toJob), page, limit, total };
}

export async function adminJobAction(jobId, { action, rider, reason, costPaise, provider = null, force = false }) {
  const job = await DeliveryJob.findById(objectId(jobId, "job ID"));
  if (!job) throw new AppError(404, "Delivery not found");
  if (action === "rebook") {
    if (OPEN.includes(job.status)) await cancelJob(job, { reason: reason || "Re-booked by MealJi", by: "admin" });
    return toJob(await (job.order ? bookForOrder(job.order, { by: "admin", provider }) : bookForMeal(job.mealDrop, { by: "admin", provider })));
  }
  if (action === "cancel") return toJob(await cancelJob(job, { reason: reason || "Cancelled by MealJi", by: "admin" }));
  if (action === "set_cost") return toJob(await updateJob(job, { costPaise, by: "admin" }));
  // Moving a partner-run delivery by hand closes it here while the partner may still be working on it.
  if (["assign_rider", "picked_up", "delivered"].includes(action) && !getProvider(job.provider).managedByKitchen && !force) {
    throw new AppError(409, "This delivery is run by the delivery partner. Send force: true to override it here.");
  }
  if (action === "assign_rider") return toJob(await updateJob(job, { rider, by: "admin" }));
  if (action === "picked_up" || action === "delivered") return toJob(await updateJob(job, { status: action, note: force ? "Admin override" : null, by: "admin" }));
  throw new AppError(422, "Unknown delivery action");
}

export async function providerOverview() {
  const accounts = await DeliveryProviderAccount.find().lean();
  return {
    providers: listProviders(),
    accounts: accounts.map((account) => ({ accountId: String(account._id), provider: account.provider, name: account.name, cities: account.cities, kitchenIds: (account.kitchens || []).map(String), isActive: account.isActive })),
  };
}

/** A partner erased a rider's personal data: remove our copies of their name and photo. */
async function redactRider(providerKey, externalId) {
  const cleared = Object.fromEntries(Object.keys(RIDER_NONE).map((key) => [`rider.${key}`, null]));
  const jobs = await DeliveryJob.find({ provider: providerKey, "rider.externalId": externalId }).select("order").lean();
  await DeliveryJob.updateMany({ provider: providerKey, "rider.externalId": externalId }, { $set: cleared });
  const orderIds = jobs.map((job) => job.order).filter(Boolean);
  if (orderIds.length) await Order.updateMany({ _id: { $in: orderIds }, "rider.externalId": externalId }, { $set: cleared });
  return jobs.length;
}

/** Provider webhooks (3PL). Unknown providers are ignored. */
export async function handleProviderWebhook(providerKey, body, headers) {
  const adapter = getProvider(providerKey);
  if (adapter.key !== providerKey) return { ignored: true };
  const update = adapter.parseWebhook(body, headers);
  if (update?.riderErased) return { processed: true, redacted: await redactRider(providerKey, update.riderErased) };
  if (!update?.providerJobId) return { ignored: true };
  const filter = { provider: providerKey, providerJobId: update.providerJobId };
  const { version, providerJobId, ...changes } = update;
  // The rider's position is shared only once the food is on its way (as with the stream);
  // a status event carrying one before pickup must not reveal where the rider is.
  const withLocation = (job) => {
    const next = changes.status || job.status;
    return next === "picked_up" ? changes : { ...changes, location: null };
  };
  // A delivered job only finishes its order/meal sync (a retry after that sync failed).
  const closed = async (job) => {
    if (job.status === "delivered" && changes.status === "delivered") await syncTargets(job, { status: "delivered", by: providerKey });
    return { ignored: true, reason: "closed" };
  };
  if (version == null) {
    const job = await DeliveryJob.findOne(filter);
    if (!job) return { ignored: true };
    if (CLOSED.includes(job.status)) return closed(job);
    await updateJob(job, { ...withLocation(job), by: providerKey });
    return { processed: true };
  }
  // Webhooks may arrive out of order, twice, or several at once: claim the event's
  // version (only newer ones win) and save only while no newer event has claimed
  // the job since, so an older status can never overwrite a newer one.
  const job = await DeliveryJob.findOneAndUpdate(
    { ...filter, $or: [{ providerVersion: null }, { providerVersion: { $lt: version } }] },
    { $set: { providerVersion: version } },
    { new: true },
  );
  if (!job) return (await DeliveryJob.exists(filter)) ? { ignored: true, reason: "stale" } : { ignored: true };
  try {
    // A job MealJi already closed (cancelled or re-booked, or delivered) takes no more updates.
    if (CLOSED.includes(job.status)) return await closed(job);
    job.$where = { providerVersion: version };
    await updateJob(job, { ...withLocation(job), by: providerKey });
  } catch (err) {
    if (err?.name === "DocumentNotFoundError") return { ignored: true, reason: "stale" };
    // Let the provider's retry apply this event again.
    await DeliveryJob.updateOne({ _id: job._id, providerVersion: version }, { $set: { providerVersion: version - 1 } });
    throw err;
  }
  return { processed: true };
}

/** Live rider position and ETA from a provider's stream; shared while the food is on its way (as for kitchen riders). */
export async function applyProviderLocation(providerKey, providerJobId, location, { eta = null, remainingDistanceM = null } = {}) {
  const job = await DeliveryJob.findOne({ provider: providerKey, providerJobId, status: "picked_up" });
  if (!job) return false;
  await updateJob(job, { location, eta, remainingDistanceM, by: providerKey });
  return true;
}

/**
 * The customer's "Call rider" button (an order or a subscription meal): the
 * partner rings the customer and connects them to the rider, numbers hidden.
 */
export async function callRider(userId, { orderId = null, mealId = null }) {
  let jobId = null;
  if (orderId) {
    jobId = (await Order.findOne({ _id: objectId(orderId, "order ID"), user: userId }).select("deliveryJob").lean())?.deliveryJob;
  } else {
    const { MealSelection } = await import("../subscription/subscription.model.js");
    jobId = (await MealSelection.findOne({ _id: objectId(mealId, "meal ID"), user: userId }).select("deliveryJob").lean())?.deliveryJob;
  }
  const job = jobId ? await DeliveryJob.findById(jobId) : null;
  if (!job || !["assigned", "picked_up", "failed"].includes(job.status)) throw new AppError(409, "The rider can be called while they are on the way");
  if (!riderCallable(job)) throw new AppError(409, job.status === "failed" ? "The rider can't be called for this delivery any more" : "Calling the rider is not available for this delivery");
  return getProvider(job.provider).callRider(job);
}

/** order.rated: passes the delivery stars (not the review text) on to the partner's rider profile; best effort. */
export async function forwardDeliveryRating({ orderId, deliveryRating }) {
  if (!deliveryRating) return;
  const order = await Order.findById(orderId).select("deliveryJob").lean();
  const job = order?.deliveryJob ? await DeliveryJob.findById(order.deliveryJob) : null;
  if (!job?.providerJobId || job.status !== "delivered") return;
  const adapter = getProvider(job.provider);
  if (adapter.key !== job.provider || !adapter.rate) return;
  await adapter.rate(job, { rating: deliveryRating });
}
