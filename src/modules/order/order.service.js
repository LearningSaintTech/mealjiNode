import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { maskPhone } from "../../common/phone.util.js";
import { objectId } from "../../common/http.js";
import { nextSequence } from "../../common/sequence.js";
import { escapeRegex } from "../../common/text.util.js";
import { istDateKey, istDateTime, addIstDays } from "../../common/time.js";
import { withTransaction } from "../../config/database.js";
import { logger } from "../../config/logger.js";
import { publishEvent, publishEventSafe } from "../../events/eventBus.js";
import { createGatewayOrder } from "../../infrastructure/payments/gateway.js";
import { storeDel, storeSetNx } from "../../infrastructure/redisStore.js";
import { publish } from "../../realtime/hub.js";
import { Address, addressSnapshot } from "../address/address.model.js";
import { buildCart } from "../cart/cart.service.js";
import { Cart } from "../cart/cart.model.js";
import { KitchenDish } from "../catalog/catalog.model.js";
import { releaseStock, reserveStock, toDish } from "../catalog/catalog.service.js";
import { Coupon } from "../coupon/coupon.model.js";
import { releaseRedemption, reserveRedemption } from "../coupon/coupon.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { Payment } from "../payment/payment.model.js";
import { refundSpentPoints, spendPoints } from "../rewards/ledger.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { Order } from "./order.model.js";
import { ACTIVE_STATUSES, STATUS_LABELS, allowedFor, customerCanCancel, kitchenActions } from "./order.states.js";

// ------------------------------------------------------------------ views

function stepsView(order) {
  return (order.kitchenSteps || []).map((step) => ({ key: step.key, label: step.label, state: step.state, at: step.at }));
}

const PAYMENT_LABELS = { upi: "UPI", card: "Card", netbanking: "Net Banking", wallet: "Wallet", cod: "Cash on Delivery" };
const IST_LABEL = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const IST_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
const istLabel = (date) => (date ? IST_LABEL.format(new Date(date)).replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM") : null);
const istTime = (date) => (date ? IST_TIME.format(new Date(date)).replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM") : null);

// Order delivered screen: the feedback chips; Cancel order: the reasons sheet.
export const RATING_TAGS = ["Delicious", "Fresh", "Warm", "On time", "Would reorder"];
export const CANCEL_REASONS = ["Ordered by mistake", "Taking too long", "Changed my mind", "Wrong address", "Other"];

/** “Today”, “Yesterday”, “4 days ago”, “Last week”, “2 weeks ago”, else the date (IST days). */
function relativeDay(date, now = new Date()) {
  if (!date) return null;
  const day = (value) => Math.floor((new Date(value).getTime() + 330 * 60_000) / 86_400_000);
  const diff = day(now) - day(date);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff} days ago`;
  if (diff < 14) return "Last week";
  if (diff < 31) return `${Math.floor(diff / 7)} weeks ago`;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(new Date(date));
}

/** “Butter chicken bowl + butter naan” (2 items), “Dal ramen, gulab cheesecake +2 more”. */
function itemsTitle(items = []) {
  const names = items.map((item) => (item.qty > 1 ? `${item.name} x ${item.qty}` : item.name));
  if (names.length <= 2) return names.join(" + ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

/** “2 min early” / “5 min late” / “On time” against the promised time. */
function punctuality(order) {
  if (!order.deliveredAt || !order.estimatedDeliveryAt) return null;
  const minutes = Math.round((new Date(order.estimatedDeliveryAt) - new Date(order.deliveredAt)) / 60_000);
  if (minutes >= 1) return `${minutes} min early`;
  if (minutes <= -1) return `${-minutes} min late`;
  return "On time";
}

/** “Large • Extra Butter Jeera Rice • + Complete Meal”, or “Regular”. */
function itemOptionsText(item) {
  const parts = [item.portion?.label, ...(item.options || []).map((option) => option.name), item.mealUpgrade?.label ? `+ ${item.mealUpgrade.label}` : null].filter(Boolean);
  return parts.length ? parts.join(" • ") : "Regular";
}

/**
 * The 4-step bar on Order confirmed / tracking: Order confirmed → Preparing
 * your food → Out for delivery → Delivered (pickup: Ready for pickup → Picked up).
 */
function progressOf(order) {
  const pickup = order.deliveryMode === "pickup";
  const steps = [
    { key: "confirmed", label: "Order confirmed", at: order.placedAt },
    { key: "preparing", label: "Preparing your food", at: order.acceptedAt },
    { key: pickup ? "ready" : "out_for_delivery", label: pickup ? "Ready for pickup" : "Out for delivery", at: pickup ? order.readyAt : order.dispatchedAt },
    { key: "delivered", label: pickup ? "Picked up" : "Delivered", at: order.deliveredAt },
  ];
  const reached = { payment_pending: -1, payment_failed: -1, placed: 0, accepted: 1, preparing: 1, ready: pickup ? 2 : 1, dispatched: 2, delivered: 3, cancelled: -1 }[order.status] ?? -1;
  return steps.map((step, index) => ({
    ...step,
    time: istTime(step.at),
    state: order.status === "cancelled" ? "cancelled" : index < reached || order.status === "delivered" ? "done" : index === reached ? (index === 0 && order.status === "placed" ? "done" : "active") : "pending",
  }));
}

export function toOrder(order, { view = "customer" } = {}) {
  const paid = ["paid", "partially_refunded", "refunded"].includes(order.paymentStatus);
  const base = {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status] || order.status,
    kitchen: { kitchenId: String(order.kitchen?._id || order.kitchen), name: order.kitchenName },
    items: (order.items || []).map((item) => ({
      lineId: item.lineId,
      kind: item.kind,
      dishId: item.dish ? String(item.dish) : null,
      comboId: item.combo ? String(item.combo) : null,
      name: item.name,
      imageUrl: item.imageUrl || null,
      isVeg: item.isVeg !== false,
      qty: item.qty,
      portion: item.portion || null,
      mealUpgrade: item.mealUpgrade || null,
      options: item.options || [],
      specialInstructions: item.specialInstructions || null,
      unitPricePaise: item.unitPricePaise,
      totalPaise: item.totalPaise,
      optionsText: itemOptionsText(item),
    })),
    itemCount: (order.items || []).reduce((sum, item) => sum + item.qty, 0),
    // Ready-to-show text for Order confirmed (times in IST).
    placedAtLabel: istLabel(order.placedAt || order.createdAt),
    etaLabel: order.scheduledFor ? `Scheduled for ${istLabel(order.scheduledFor)}` : order.etaMinutes ? `${order.etaMinutes} minutes` : null,
    progress: progressOf(order),
    // Orders list and Order delivered.
    title: itemsTitle(order.items),
    dateLabel: relativeDay(order.placedAt || order.createdAt),
    arrivingByLabel: ACTIVE_STATUSES.includes(order.status) && order.estimatedDeliveryAt ? istTime(order.estimatedDeliveryAt) : null,
    deliveredAtLabel: istTime(order.deliveredAt),
    punctualityLabel: punctuality(order),
    canRate: order.status === "delivered" && !order.rating?.at,
    ratingTags: order.status === "delivered" && !order.rating?.at ? RATING_TAGS : [],
    paymentMethodLabel: PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod,
    amountPaidPaise: paid ? order.bill?.grandTotalPaise ?? 0 : 0,
    amountDueOnDeliveryPaise: order.paymentStatus === "cod_pending" ? order.bill?.grandTotalPaise ?? 0 : 0,
    address: order.address || null,
    deliveryMode: order.deliveryMode,
    scheduledFor: order.scheduledFor || null,
    bill: order.bill,
    couponCode: order.couponCode || null,
    pointsUsed: order.pointsUsed || 0,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    statusHistory: (order.statusHistory || []).map((entry) => ({ status: entry.status, label: STATUS_LABELS[entry.status], at: entry.at, ...(view === "customer" ? {} : { by: entry.by, note: entry.note }) })),
    kitchenSteps: stepsView(order),
    currentActivity: (order.kitchenSteps || []).find((step) => step.state === "active")?.label || null,
    etaMinutes: order.etaMinutes,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
    placedAt: order.placedAt || order.createdAt,
    acceptedAt: order.acceptedAt,
    readyAt: order.readyAt,
    dispatchedAt: order.dispatchedAt,
    deliveredAt: order.deliveredAt,
    cancelledAt: order.cancelledAt,
    cancellation: order.cancellation?.by ? order.cancellation : null,
    chefNote: order.chefNote || null,
    rating: order.rating?.at ? order.rating : null,
    rider: order.rider?.name ? { name: order.rider.name, phoneMasked: order.rider.phone ? maskPhone(order.rider.phone) : null, vehicleNumber: order.rider.vehicleNumber || null } : null,
    refundedPaise: order.refundedPaise || 0,
    invoiceId: order.invoice ? String(order.invoice._id || order.invoice) : null,
    invoiceNumber: order.invoice?.invoiceNumber || null,
    createdAt: order.createdAt,
  };
  if (view === "customer") return base;
  return {
    ...base,
    customer: { userId: String(order.user?._id || order.user), name: order.customer?.name || null, phone: view === "admin" ? order.customer?.phone : maskPhone(order.customer?.phone || "") },
    rider: order.rider?.name ? { ...order.rider } : null,
    actions: view === "kitchen" ? kitchenActions(order) : undefined,
    isFirstOrder: Boolean(order.isFirstOrder),
    slaAlertedAt: order.slaAlertedAt || null,
    deliveryJobId: order.deliveryJob ? String(order.deliveryJob._id || order.deliveryJob) : null,
    delivery: order.deliveryJob?.status ? { status: order.deliveryJob.status, provider: order.deliveryJob.provider, rider: order.deliveryJob.rider?.name ? order.deliveryJob.rider : null, trackingUrl: order.deliveryJob.trackingUrl || null, failureReason: order.deliveryJob.failureReason || null } : null,
    source: order.source,
  };
}

function realtimeSummary(order) {
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    itemCount: (order.items || []).reduce((sum, item) => sum + item.qty, 0),
    totalPaise: order.bill?.grandTotalPaise,
    deliveryMode: order.deliveryMode,
    paymentMethod: order.paymentMethod,
    placedAt: order.placedAt,
    customerName: order.customer?.name || null,
  };
}

function broadcast(order, previous = null) {
  const at = new Date().toISOString();
  const orderId = String(order._id);
  if (!previous || previous !== order.status) {
    publish(`order:${orderId}`, "order:status", { orderId, status: order.status, at });
    publish(`order:${orderId}`, "track:status", order.status);
    publish(`user:${order.user}`, "order:status", { orderId, status: order.status, at });
  }
  const kitchenEvent = !previous && order.status === "placed" ? "kitchen:order_new" : "kitchen:order_updated";
  if (order.status !== "payment_pending" && order.status !== "payment_failed") {
    publish(`kitchen:${order.kitchen}`, kitchenEvent, realtimeSummary(order));
  }
  publish("admin:ops", "kitchen:order_updated", { ...realtimeSummary(order), kitchenId: String(order.kitchen) });
}

// ------------------------------------------------------------------ placement

async function orderNumber(session) {
  const value = await nextSequence("order", { session });
  // Short, unguessable-enough, human-friendly: #MJ-10023 style, offset so numbers start at 5 digits.
  return `MJ-${10000 + value}`;
}

function stepsFrom(policy) {
  return (policy.kitchenSteps || []).map((label, index) => ({ key: `step_${index + 1}`, label, state: "pending", at: null }));
}

/**
 * Places an order from the cart. Re-prices on the server, checks the kitchen is
 * open and accepting, the address is in range and items are available; then in
 * one transaction creates the order, reserves daily stock, the coupon and the
 * points. Online payments return the gateway order to open checkout with; COD
 * orders are placed straight away. The cart is cleared once the order exists.
 */
export async function placeOrder(userId, input, options = {}) {
  // One placement at a time per customer: a double tap on Pay must never make
  // two orders (the cart is only emptied once the first order exists).
  const lockKey = `order:placing:${userId}`;
  const locked = await storeSetNx(lockKey, "1", 60).catch(() => true);
  if (!locked) throw new AppError(409, "Your order is already being placed", [{ field: "order", message: "ORDER_IN_PROGRESS" }]);
  try {
    return await placeOrderLocked(userId, input, options);
  } finally {
    await storeDel(lockKey).catch(() => {});
  }
}

async function placeOrderLocked(userId, input, { platform = null, user: signedIn = null } = {}) {
  const rawCart = await Cart.findOne({ user: userId });
  const cart = await buildCart(userId, input, { user: signedIn, cart: rawCart });
  if (!cart.canCheckout) {
    const blocker = cart.blockers.find((item) => !item.soft) || cart.blockers[0];
    throw new AppError(409, blocker?.message || "Your cart cannot be ordered yet", cart.blockers.map((item) => ({ field: "cart", message: item.code })));
  }
  if (cart.coupon && !cart.coupon.valid) throw new AppError(409, cart.coupon.message, [{ field: "coupon", message: "COUPON_INVALID" }]);
  const paymentMethod = input.paymentMethod;
  const method = cart.paymentMethods.find((item) => item.method === paymentMethod);
  if (!method?.enabled) throw new AppError(422, "Choose an available payment method");

  const { kitchenRepository } = await import("../kitchen/kitchen.repository.js");
  const [user, kitchen] = await Promise.all([
    signedIn || User.findById(userId).lean(),
    kitchenRepository.findActiveById(cart.kitchen.kitchenId),
  ]);
  const policy = (await resolveSetting("order_policy", { kitchenId: kitchen._id, city: kitchen.city })).values;
  const address = cart.deliveryMode === "delivery" ? await Address.findById(cart.address.addressId).lean() : null;
  const orderable = cart.items.filter((line) => line.isAvailable);
  const stockLines = orderable.flatMap((line) => line.dishIds);
  const previousOrders = await Order.countDocuments({ user: userId, status: { $in: ["delivered", ...ACTIVE_STATUSES] } });
  const cod = paymentMethod === "cod";
  const now = new Date();
  const bill = cart.bill;

  const order = await withTransaction(async (session) => {
    const reserved = await reserveStock(stockLines, { session, at: now });
    if (!reserved) throw new AppError(409, "Some dishes just sold out. Check your cart.", [{ field: "cart", message: "ITEMS_UNAVAILABLE" }]);
    const [created] = await Order.create([{
      orderNumber: await orderNumber(session),
      user: userId,
      kitchen: kitchen._id,
      kitchenName: kitchen.name,
      city: kitchen.city,
      items: orderable.map((line) => ({
        lineId: line.lineId,
        kind: line.kind,
        dish: line.dishId || null,
        combo: line.comboId || null,
        name: line.name,
        imageUrl: line.imageUrl,
        isVeg: line.isVeg,
        qty: line.qty,
        portion: line.portion || null,
        mealUpgrade: line.mealUpgrade || null,
        options: line.options || [],
        specialInstructions: line.specialInstructions || null,
        unitPricePaise: line.unitPricePaise,
        totalPaise: line.totalPaise,
        dishIds: line.dishIds,
      })),
      customer: { name: user.name, phone: user.phoneNumber },
      address: address ? addressSnapshot(address) : null,
      deliveryMode: cart.deliveryMode,
      // Only a slot the cart validated (buildCart blocks times that are not offered).
      scheduledFor: cart.delivery?.type === "scheduled" ? new Date(cart.delivery.scheduledFor) : null,
      bill,
      couponCode: cart.coupon?.valid ? cart.coupon.code : null,
      pointsUsed: cart.points?.usedPoints || 0,
      paymentMethod,
      paymentStatus: cod ? "cod_pending" : "pending",
      status: cod ? "placed" : "payment_pending",
      statusHistory: [{ status: cod ? "placed" : "payment_pending", at: now, by: { userId: String(userId), role: "customer", name: user.name } }],
      kitchenSteps: stepsFrom(policy),
      etaMinutes: cart.etaMinutes,
      estimatedDeliveryAt: cart.delivery?.type === "scheduled" ? new Date(cart.delivery.scheduledFor) : new Date(now.getTime() + cart.etaMinutes * 60_000),
      placedAt: cod ? now : null,
      expiresAt: cod ? null : new Date(now.getTime() + policy.unpaidOrderExpiryMinutes * 60_000),
      chefNote: rawCart?.chefNote || null,
      isFirstOrder: previousOrders === 0,
      source: platform ? "admin" : "app",
      platform: input.platform || null,
    }], session ? { session } : {});
    if (created.couponCode) {
      const coupon = await Coupon.findOne({ code: created.couponCode }).session(session || null).lean();
      if (coupon) await reserveRedemption({ coupon, userId, orderId: created._id, discountPaise: bill.discountPaise, session });
    }
    if (created.pointsUsed > 0) {
      await spendPoints({ userId, points: created.pointsUsed, source: "checkout", title: `Used on order ${created.orderNumber}`, referenceType: "order", referenceId: String(created._id), dedupeKey: `order:${created._id}:spend`, session });
    }
    if (cod) {
      await publishEvent("order.placed", { orderId: String(created._id), userId: String(userId), kitchenId: String(kitchen._id), totalPaise: bill.grandTotalPaise, paymentMethod, isFirstOrder: created.isFirstOrder }, { session, aggregate: { type: "order", id: created._id } });
    } else {
      await publishEvent("order.created", { orderId: String(created._id), userId: String(userId), kitchenId: String(kitchen._id), totalPaise: bill.grandTotalPaise }, { session, aggregate: { type: "order", id: created._id } });
    }
    return created;
  });

  await Cart.updateOne({ user: userId }, { $set: { items: [], couponCode: null, usePoints: false, tipPaise: 0, chefNote: null, scheduledFor: null }, $inc: { __v: 1 } });

  // C. If the gateway is down the order still exists: the app shows “Retry
  // payment” (POST /orders/{id}/retry-payment) instead of losing the cart.
  let payment = null;
  let paymentError = null;
  if (!cod) {
    try {
      payment = await startPayment(order, user);
    } catch (err) {
      logger.error({ err: err.message, orderId: String(order._id) }, "Could not start payment");
      paymentError = { message: "We could not open the payment page. Tap Retry payment.", retryable: true };
    }
  }
  if (cod) {
    broadcast(order);
    if (policy.acceptMode === "auto") await transition(order._id, "accepted", { actor: "system", note: "Accepted automatically" }).catch((err) => logger.warn({ err: err.message }, "Auto-accept failed"));
  }
  return { order: toOrder(await Order.findById(order._id).lean()), payment, paymentError };
}

/** Creates (or re-creates for a retry) the gateway order for an unpaid order. */
export async function startPayment(order, user) {
  const gateway = await createGatewayOrder({ amountPaise: order.bill.grandTotalPaise, receipt: order.orderNumber, notes: { orderId: String(order._id), orderNumber: order.orderNumber } });
  const payment = await Payment.create({
    user: order.user,
    refType: "order",
    refId: order._id,
    kitchen: order.kitchen,
    amountPaise: order.bill.grandTotalPaise,
    method: order.paymentMethod,
    gateway: gateway.gateway,
    gatewayOrderId: gateway.gatewayOrderId,
  });
  return {
    paymentId: String(payment._id),
    gateway: gateway.gateway,
    keyId: gateway.keyId,
    gatewayOrderId: gateway.gatewayOrderId,
    amountPaise: gateway.amountPaise,
    currency: "INR",
    prefill: { name: user?.name || null, contact: user?.phoneNumber || null, email: user?.email || null },
    description: `MealJi order ${order.orderNumber}`,
  };
}

export async function retryPayment(userId, orderId) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), user: userId });
  if (!order) throw new AppError(404, "Order not found");
  if (!["payment_pending", "payment_failed"].includes(order.status)) throw new AppError(409, "This order does not need payment");
  const policy = (await resolveSetting("order_policy", { kitchenId: order.kitchen })).values;
  if (order.status === "payment_failed") {
    // Stock and offers were released when payment failed; take them again.
    const ok = await reserveStock(order.items.flatMap((item) => item.dishIds));
    if (!ok) throw new AppError(409, "Some dishes sold out meanwhile. Please order again.");
    order.status = "payment_pending";
    order.statusHistory.push({ status: "payment_pending", at: new Date(), by: { userId: String(userId), role: "customer" }, note: "Payment retried" });
  }
  order.expiresAt = new Date(Date.now() + policy.unpaidOrderExpiryMinutes * 60_000);
  await order.save();
  return { order: toOrder(order.toObject()), payment: await startPayment(order, await User.findById(userId).lean()) };
}

// ------------------------------------------------------------------ transitions

const TIMESTAMP = { placed: "placedAt", accepted: "acceptedAt", ready: "readyAt", dispatched: "dispatchedAt", delivered: "deliveredAt", cancelled: "cancelledAt" };

/**
 * Moves an order to `to` if the actor may. Handles timestamps, history, kitchen
 * steps, stock/coupon/points release on cancellation, the domain event and the
 * realtime fan-out. Idempotent when the order is already in `to`.
 */
export async function transition(orderId, to, { actor, by = null, note = null, reason = null, cancelledBy = null, session = null } = {}) {
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw new AppError(404, "Order not found");
  if (order.status === to) return order;
  if (!allowedFor(order, to, actor)) throw new AppError(409, `Cannot move an order from "${STATUS_LABELS[order.status]}" to "${STATUS_LABELS[to]}"`);
  const previous = order.status;
  const now = new Date();
  order.status = to;
  if (TIMESTAMP[to]) order[TIMESTAMP[to]] = now;
  order.statusHistory.push({ status: to, at: now, by: by || { role: actor }, note: note || reason || null });

  if (to === "preparing" && order.kitchenSteps.length && !order.kitchenSteps.some((step) => step.state !== "pending")) {
    order.kitchenSteps[0].state = "active";
    order.kitchenSteps[0].at = now;
  }
  if (["ready", "dispatched", "delivered"].includes(to)) {
    for (const step of order.kitchenSteps) {
      if (step.state !== "done") {
        step.state = "done";
        step.at = step.at || now;
      }
    }
  }
  if (to === "accepted" && order.etaMinutes) order.estimatedDeliveryAt = new Date(now.getTime() + order.etaMinutes * 60_000);
  if (to === "delivered" && order.paymentStatus === "cod_pending") order.paymentStatus = "cod_collected";
  if (to === "cancelled") order.cancellation = { by: cancelledBy || actor, reason: reason || null, note };
  if (to === "payment_failed") order.paymentStatus = "failed";
  if (to === "placed") {
    order.placedAt = now;
    order.expiresAt = null;
  }
  await order.save({ session: session || undefined });

  // Releases for orders that will not be fulfilled.
  // A failed payment keeps the offer and points for a retry; cancelling gives them back.
  if (to === "cancelled" || to === "payment_failed") {
    if (previous !== "payment_failed") await releaseStock(order.items.flatMap((item) => item.dishIds)).catch(() => {});
  }
  if (to === "cancelled") {
    await releaseRedemption(order._id).catch(() => {});
    if (order.pointsUsed > 0) await refundSpentPoints({ userId: order.user, referenceId: String(order._id), title: `Points back from order ${order.orderNumber}` }).catch(() => {});
  }

  const payload = { orderId: String(order._id), userId: String(order.user), kitchenId: String(order.kitchen), from: previous, to, actor, reason: reason || null, totalPaise: order.bill?.grandTotalPaise, paymentMethod: order.paymentMethod, isFirstOrder: order.isFirstOrder };
  await publishEventSafe("order.status_changed", payload, { aggregate: { type: "order", id: order._id } });
  if (to === "placed") await publishEventSafe("order.placed", payload, { aggregate: { type: "order", id: order._id } });
  if (to === "delivered") await publishEventSafe("order.delivered", payload, { aggregate: { type: "order", id: order._id } });
  if (to === "cancelled") await publishEventSafe("order.cancelled", payload, { aggregate: { type: "order", id: order._id } });
  broadcast(order, previous === "payment_pending" && to === "placed" ? null : previous);
  return order;
}

export async function setKitchenStep(kitchenId, orderId, { stepKey, state }) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), kitchen: kitchenId });
  if (!order) throw new AppError(404, "Order not found");
  if (!["accepted", "preparing"].includes(order.status)) throw new AppError(409, "Steps can be updated while the order is being prepared");
  const index = order.kitchenSteps.findIndex((step) => step.key === stepKey);
  if (index < 0) throw new AppError(404, "Step not found");
  const now = new Date();
  if (order.status === "accepted") {
    order.status = "preparing";
    order.statusHistory.push({ status: "preparing", at: now, by: { role: "kitchen" } });
  }
  order.kitchenSteps.forEach((step, position) => {
    if (position < index && step.state !== "done") {
      step.state = "done";
      step.at = step.at || now;
    }
  });
  order.kitchenSteps[index].state = state;
  order.kitchenSteps[index].at = now;
  if (state === "done" && order.kitchenSteps[index + 1] && order.kitchenSteps[index + 1].state === "pending") {
    order.kitchenSteps[index + 1].state = "active";
    order.kitchenSteps[index + 1].at = now;
  }
  await order.save();
  const step = order.kitchenSteps[index];
  const active = order.kitchenSteps.find((item) => item.state === "active");
  publish(`order:${order._id}`, "order:kitchen_step", { orderId: String(order._id), stepKey: step.key, label: step.label, state: step.state, at: now.toISOString(), currentActivity: active?.label || null });
  publish(`kitchen:${order.kitchen}`, "kitchen:order_updated", realtimeSummary(order));
  return toOrder(order.toObject(), { view: "kitchen" });
}

// ------------------------------------------------------------------ customer

export async function listMyOrders(userId, { page = 1, limit = 20, status }) {
  const filter = { user: userId };
  if (status === "active") filter.status = { $in: [...ACTIVE_STATUSES, "payment_pending"] };
  if (status === "past") filter.status = { $in: ["delivered", "cancelled", "payment_failed"] };
  const [items, total, active, past] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
    // Tab badges: Current (n) and Past (n).
    Order.countDocuments({ user: userId, status: { $in: [...ACTIVE_STATUSES, "payment_pending"] } }),
    Order.countDocuments({ user: userId, status: { $in: ["delivered", "cancelled", "payment_failed"] } }),
  ]);
  return { items: items.map((order) => toOrder(order)), page, limit, total, hasMore: page * limit < total, counts: { active, past } };
}

export async function getMyOrder(userId, orderId) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), user: userId }).lean();
  if (!order) throw new AppError(404, "Order not found");
  return order;
}

export async function liveView(userId, orderId) {
  const order = await getMyOrder(userId, orderId);
  const minutesLeft = order.estimatedDeliveryAt ? Math.max(0, Math.round((new Date(order.estimatedDeliveryAt) - Date.now()) / 60_000)) : null;
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: STATUS_LABELS[order.status],
    timeline: ["placed", "accepted", "preparing", "ready", order.deliveryMode === "pickup" ? null : "dispatched", "delivered"].filter(Boolean).map((status) => ({
      status,
      label: STATUS_LABELS[status],
      done: (order.statusHistory || []).some((entry) => entry.status === status),
      at: (order.statusHistory || []).find((entry) => entry.status === status)?.at || null,
    })),
    kitchenSteps: stepsView(order),
    currentActivity: (order.kitchenSteps || []).find((step) => step.state === "active")?.label || null,
    etaMinutes: minutesLeft,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
    // “Arriving by 9:25 PM • 14 min”
    arrivingByLabel: order.estimatedDeliveryAt && ACTIVE_STATUSES.includes(order.status) ? `Arriving by ${istTime(order.estimatedDeliveryAt)}${minutesLeft != null ? ` • ${minutesLeft} min` : ""}` : null,
    rider: order.rider?.name ? { name: order.rider.name, phoneMasked: order.rider.phone ? maskPhone(order.rider.phone) : null, vehicleNumber: order.rider.vehicleNumber || null } : null,
    canCancel: customerCanCancel(order, (await resolveSetting("order_policy", { kitchenId: order.kitchen })).values),
    cancelReasons: CANCEL_REASONS,
  };
}

export async function trackingView(userId, orderId) {
  const order = await getMyOrder(userId, orderId);
  const { DeliveryJob } = await import("../delivery/delivery.model.js");
  const job = order.deliveryJob ? await DeliveryJob.findById(order.deliveryJob).lean() : null;
  const { kitchenRepository } = await import("../kitchen/kitchen.repository.js");
  const kitchen = await kitchenRepository.findActiveById(order.kitchen);
  return {
    orderId: String(order._id),
    status: order.status,
    kitchen: kitchen ? { name: kitchen.name, latitude: kitchen.latitude, longitude: kitchen.longitude } : null,
    destination: order.address ? { latitude: order.address.latitude, longitude: order.address.longitude, fullAddress: order.address.fullAddress } : null,
    rider: order.rider?.name ? { name: order.rider.name, phoneMasked: order.rider.phone ? maskPhone(order.rider.phone) : null, vehicleNumber: order.rider.vehicleNumber || null } : null,
    location: job?.lastLocation?.lat != null ? job.lastLocation : null,
    trackingUrl: job?.trackingUrl || null,
    deliveryStatus: job?.status || null,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
  };
}

export async function cancelMyOrder(userId, orderId, { reason }) {
  const order = await getMyOrder(userId, orderId);
  const policy = (await resolveSetting("order_policy", { kitchenId: order.kitchen })).values;
  if (!customerCanCancel(order, policy)) throw new AppError(409, "This order can no longer be cancelled here. Contact support.");
  const updated = await transition(order._id, "cancelled", { actor: order.status === "placed" ? "customer" : "customer", by: { userId: String(userId), role: "customer" }, reason: reason || "Cancelled by customer", cancelledBy: "customer" });
  await refundIfPaid(updated, { reason: "Order cancelled by customer", actor: { userId: String(userId), role: "customer" }, automatic: true });
  return toOrder(await Order.findById(order._id).lean());
}

export async function rateOrder(userId, orderId, input) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), user: userId });
  if (!order) throw new AppError(404, "Order not found");
  if (order.status !== "delivered") throw new AppError(409, "You can rate an order once it is delivered");
  if (order.rating?.at) throw new AppError(409, "You already rated this order");
  const policy = (await resolveSetting("order_policy", { kitchenId: order.kitchen })).values;
  if (Date.now() - new Date(order.deliveredAt).getTime() > policy.ratingWindowDays * 24 * 3600_000) throw new AppError(409, "The rating window for this order has closed");
  const rating = {
    food: input.foodRating,
    delivery: input.deliveryRating ?? null,
    tags: (input.tags || []).filter((tag) => typeof tag === "string").map((tag) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 10),
    comment: input.comment ? String(input.comment).slice(0, 500) : null,
    dishRatings: (input.dishRatings || []).slice(0, 20)
      .filter((item) => Number.isInteger(Number(item?.rating)) && item.rating >= 1 && item.rating <= 5 && order.items.some((line) => String(line.dish) === String(item.dishId)))
      .map((item) => ({ dishId: item.dishId, rating: Number(item.rating) })),
    at: new Date(),
  };
  // Two taps on Submit: only the first one claims the rating.
  const claimed = await Order.updateOne({ _id: order._id, "rating.at": null }, { $set: { rating } });
  if (!claimed.modifiedCount) throw new AppError(409, "You already rated this order");
  // Rolling averages, updated in one atomic step per document (no lost updates).
  const addScore = (score) => [{ $set: {
    ratingAvg: { $divide: [{ $add: [{ $multiply: [{ $ifNull: ["$ratingAvg", 0] }, { $ifNull: ["$ratingCount", 0] }] }, score] }, { $add: [{ $ifNull: ["$ratingCount", 0] }, 1] }] },
    ratingCount: { $add: [{ $ifNull: ["$ratingCount", 0] }, 1] },
  } }];
  const dishScores = rating.dishRatings.length ? rating.dishRatings : order.items.filter((item) => item.dish).map((item) => ({ dishId: item.dish, rating: input.foodRating }));
  for (const score of dishScores) await KitchenDish.updateOne({ _id: score.dishId }, addScore(Number(score.rating)));
  await Kitchen.updateOne({ _id: order.kitchen }, addScore(input.foodRating));
  order.rating = rating;
  await publishEventSafe("order.rated", { orderId: String(order._id), userId: String(userId), kitchenId: String(order.kitchen), foodRating: input.foodRating, deliveryRating: input.deliveryRating ?? null }, { aggregate: { type: "order", id: order._id } });
  return toOrder(order.toObject());
}

/** Puts a past order's items back into the cart (only what is still orderable). */
export async function reorder(userId, orderId, { replaceCart = false } = {}) {
  const order = await getMyOrder(userId, orderId);
  const { addItem, buildCart: build } = await import("../cart/cart.service.js");
  // The cart holds another kitchen's food: ask first (same answer as Add to cart).
  const current = await Cart.findOne({ user: userId }).select("kitchen items").lean();
  if (current?.items?.length && current.kitchen && String(current.kitchen) !== String(order.kitchen) && !replaceCart) {
    throw new AppError(409, "Your cart has items from another kitchen. Replace them?", [{ field: "cart", message: "CART_KITCHEN_MISMATCH" }]);
  }
  const skipped = [];
  let first = replaceCart;
  for (const item of order.items) {
    try {
      await addItem(userId, {
        dishId: item.kind === "dish" ? String(item.dish) : undefined,
        comboId: item.kind === "combo" ? String(item.combo) : undefined,
        qty: item.qty,
        portionId: item.portion?.portionId || null,
        mealUpgrade: Boolean(item.mealUpgrade),
        optionIds: (item.options || []).map((option) => option.optionId),
        specialInstructions: item.specialInstructions || null,
        replaceCart: first,
      });
      first = false;
    } catch (err) {
      skipped.push({ name: item.name, reason: err.message });
    }
  }
  const cart = await build(userId);
  return { cart, skipped, added: order.items.length - skipped.length, message: skipped.length ? `${skipped.length} item${skipped.length === 1 ? " is" : "s are"} not available right now` : null };
}

export async function usualDishes(userId, kitchenId, limit = 6) {
  const rows = await Order.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)), kitchen: new mongoose.Types.ObjectId(String(kitchenId)), status: "delivered" } },
    { $sort: { createdAt: -1 } },
    { $limit: 30 },
    { $unwind: "$items" },
    { $match: { "items.dish": { $ne: null } } },
    { $group: { _id: "$items.dish", count: { $sum: "$items.qty" }, last: { $max: "$createdAt" } } },
    { $sort: { count: -1, last: -1 } },
    { $limit: limit * 2 },
  ]);
  const dishes = await KitchenDish.find({ _id: { $in: rows.map((row) => row._id) }, isActive: true, approvalStatus: "live" }).lean();
  const byId = new Map(dishes.map((dish) => [String(dish._id), dish]));
  return rows.map((row) => byId.get(String(row._id))).filter(Boolean).slice(0, limit).map((dish) => toDish(dish));
}

// ------------------------------------------------------------------ refunds on cancel

/** Starts a full refund for a paid online order (used on cancellations). */
export async function refundIfPaid(order, { reason, actor, automatic = false }) {
  if (!["paid", "partially_refunded"].includes(order.paymentStatus)) return null;
  const { requestRefund } = await import("../payment/payment.service.js");
  const amountPaise = order.bill.grandTotalPaise - (order.refundedPaise || 0);
  if (amountPaise <= 0) return null;
  return requestRefund({ orderId: order._id, amountPaise, reason, actor, permissions: automatic ? ["refunds.approve"] : actor?.permissions || [] });
}

// ------------------------------------------------------------------ kitchen desk

export async function listKitchenOrders(kitchenId, { scope = "active", date = null, page = 1, limit = 50 }) {
  const filter = { kitchen: kitchenId };
  if (scope === "active") filter.status = { $in: ACTIVE_STATUSES };
  else if (scope === "new") filter.status = "placed";
  else {
    filter.status = { $in: ["delivered", "cancelled"] };
    const day = date || istDateKey();
    filter.createdAt = { $gte: istDateTime(day, "00:00"), $lt: istDateTime(addIstDays(day, 1), "00:00") };
  }
  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: scope === "history" ? -1 : 1 }).skip((page - 1) * limit).limit(limit).populate("deliveryJob", "status provider rider trackingUrl failureReason").lean(),
    Order.countDocuments(filter),
  ]);
  return { items: items.map((order) => toOrder(order, { view: "kitchen" })), page, limit, total };
}

export async function kitchenSummary(kitchenId) {
  const start = istDateTime(istDateKey(), "00:00");
  const [row] = await Order.aggregate([
    { $match: { kitchen: new mongoose.Types.ObjectId(String(kitchenId)), createdAt: { $gte: start }, status: { $nin: ["payment_pending", "payment_failed"] } } },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        active: { $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] } },
        newOrders: { $sum: { $cond: [{ $eq: ["$status", "placed"] }, 1, 0] } },
        salesPaise: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, "$bill.itemTotalPaise", 0] } },
        acceptMs: { $avg: { $cond: [{ $and: ["$acceptedAt", "$placedAt"] }, { $subtract: ["$acceptedAt", "$placedAt"] }, null] } },
        prepMs: { $avg: { $cond: [{ $and: ["$readyAt", "$acceptedAt"] }, { $subtract: ["$readyAt", "$acceptedAt"] }, null] } },
      },
    },
  ]);
  return {
    date: istDateKey(),
    orders: row?.orders || 0,
    delivered: row?.delivered || 0,
    cancelled: row?.cancelled || 0,
    active: row?.active || 0,
    newOrders: row?.newOrders || 0,
    salesPaise: row?.salesPaise || 0,
    avgAcceptMinutes: row?.acceptMs ? Math.round(row.acceptMs / 60_000) : null,
    avgPrepMinutes: row?.prepMs ? Math.round(row.prepMs / 60_000) : null,
  };
}

export async function kitchenSetStatus(kitchenId, orderId, { status, reason }, by) {
  const order = await Order.findOne({ _id: objectId(orderId, "order ID"), kitchen: kitchenId }).lean();
  if (!order) throw new AppError(404, "Order not found");
  if (status === "cancelled" && !reason) throw new AppError(422, "Give a reason for rejecting the order");
  const updated = await transition(order._id, status, { actor: "kitchen", by, reason, cancelledBy: "kitchen" });
  if (status === "cancelled") await refundIfPaid(updated, { reason: `Rejected by kitchen: ${reason}`, actor: by, automatic: true });
  return toOrder((await Order.findById(order._id).lean()), { view: "kitchen" });
}

// ------------------------------------------------------------------ admin

export async function listOrders(query) {
  const page = query.page || 1;
  const limit = query.limit || 25;
  const filter = {};
  if (query.status) filter.status = query.status === "active" ? { $in: ACTIVE_STATUSES } : query.status;
  if (query.kitchenId) filter.kitchen = objectId(query.kitchenId, "kitchen ID");
  if (query.userId) filter.user = objectId(query.userId, "user ID");
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.q) {
    const text = String(query.q).trim();
    filter.$or = [{ orderNumber: { $regex: escapeRegex(text.toUpperCase()) } }, { "customer.phone": { $regex: escapeRegex(text.replace(/\D/g, "") || "^$") } }, { "customer.name": { $regex: escapeRegex(text), $options: "i" } }];
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }
  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  return { items: items.map((order) => toOrder(order, { view: "admin" })), page, limit, total };
}

export async function getOrderAdmin(orderId) {
  const order = await Order.findById(objectId(orderId, "order ID")).populate("invoice", "invoiceNumber").lean();
  if (!order) throw new AppError(404, "Order not found");
  const [payments, refunds] = await Promise.all([
    Payment.find({ refType: "order", refId: order._id }).sort({ createdAt: -1 }).lean(),
    (await import("../payment/payment.model.js")).Refund.find({ order: order._id }).sort({ createdAt: -1 }).lean(),
  ]);
  const { DeliveryJob } = await import("../delivery/delivery.model.js");
  const delivery = order.deliveryJob ? await DeliveryJob.findById(order.deliveryJob).lean() : null;
  return {
    ...toOrder(order, { view: "admin" }),
    payments: payments.map((payment) => ({ paymentId: String(payment._id), gateway: payment.gateway, method: payment.method, amountPaise: payment.amountPaise, status: payment.status, gatewayPaymentId: payment.gatewayPaymentId, failureReason: payment.failureReason, capturedAt: payment.capturedAt, createdAt: payment.createdAt })),
    refunds: refunds.map((refund) => ({ refundId: String(refund._id), amountPaise: refund.amountPaise, reason: refund.reason, status: refund.status, requestedBy: refund.requestedBy, reviewedBy: refund.reviewedBy, processedAt: refund.processedAt, createdAt: refund.createdAt })),
    delivery: delivery ? { jobId: String(delivery._id), provider: delivery.provider, status: delivery.status, rider: delivery.rider, costPaise: delivery.costPaise, history: delivery.history } : null,
  };
}

export async function adminSetStatus(orderId, { status, reason }, by) {
  const order = await transition(objectId(orderId, "order ID"), status, { actor: "admin", by, reason, cancelledBy: "admin" });
  return toOrder(order.toObject(), { view: "admin" });
}

/**
 * Admin cancel with an optional refund: "full" refunds what was paid, "partial"
 * refunds `amountPaise`, "none" refunds nothing (e.g. COD not yet collected).
 */
export async function adminCancel(orderId, { reason, refund = "full", amountPaise = null }, actor) {
  const order = await transition(objectId(orderId, "order ID"), "cancelled", { actor: "admin", by: actor, reason, cancelledBy: "admin" });
  let refundResult = null;
  // Online payments (also partly refunded ones) and cash already collected can be refunded.
  if (["paid", "partially_refunded", "cod_collected"].includes(order.paymentStatus) && refund !== "none") {
    const { requestRefund } = await import("../payment/payment.service.js");
    const amount = refund === "partial" ? amountPaise : order.bill.grandTotalPaise - (order.refundedPaise || 0);
    refundResult = await requestRefund({ orderId: order._id, amountPaise: amount, reason: `Cancelled: ${reason}`, actor, permissions: actor.permissions });
  }
  return { order: toOrder((await Order.findById(order._id).lean()), { view: "admin" }), refund: refundResult };
}

// ------------------------------------------------------------------ jobs

/**
 * Every minute: expires unpaid online orders, raises accept-SLA alerts and
 * auto-cancels (with refund) orders the kitchen never accepted.
 */
export async function orderWatchdog() {
  const now = new Date();
  let changed = 0;
  const unpaid = await Order.find({ status: "payment_pending", expiresAt: { $lte: now } }).limit(200).lean();
  for (const order of unpaid) {
    await transition(order._id, "payment_failed", { actor: "system", note: "Payment not completed in time" }).catch(() => {});
    changed += 1;
  }
  // Failed payments not retried within a day are closed, releasing offers and points.
  const stale = await Order.find({ status: "payment_failed", updatedAt: { $lte: new Date(now.getTime() - 24 * 3600_000) } }).limit(200).lean();
  for (const order of stale) {
    await transition(order._id, "cancelled", { actor: "system", reason: "Payment was not completed", cancelledBy: "system" }).catch(() => {});
    changed += 1;
  }
  const waiting = await Order.find({ status: "placed", placedAt: { $ne: null } }).limit(500).lean();
  for (const order of waiting) {
    const policy = (await resolveSetting("order_policy", { kitchenId: order.kitchen })).values;
    const waitedMin = (now - new Date(order.placedAt)) / 60_000;
    if (policy.autoCancelAfterMinutes > 0 && waitedMin >= policy.autoCancelAfterMinutes) {
      const cancelled = await transition(order._id, "cancelled", { actor: "system", reason: "The kitchen did not accept in time", cancelledBy: "system" }).catch(() => null);
      if (cancelled) await refundIfPaid(cancelled, { reason: "Auto-cancelled: not accepted in time", actor: { role: "system" }, automatic: true }).catch(() => {});
      changed += 1;
      continue;
    }
    if (!order.slaAlertedAt && waitedMin >= policy.acceptSlaMinutes) {
      await Order.updateOne({ _id: order._id }, { $set: { slaAlertedAt: now } });
      publish(`kitchen:${order.kitchen}`, "kitchen:sla_breach", { orderId: String(order._id), orderNumber: order.orderNumber, waitingMinutes: Math.round(waitedMin) });
      publish("admin:ops", "kitchen:sla_breach", { orderId: String(order._id), orderNumber: order.orderNumber, kitchenId: String(order.kitchen), waitingMinutes: Math.round(waitedMin) });
      await publishEventSafe("order.sla_breached", { orderId: String(order._id), kitchenId: String(order.kitchen), waitingMinutes: Math.round(waitedMin) });
      changed += 1;
    }
  }
  return changed;
}
