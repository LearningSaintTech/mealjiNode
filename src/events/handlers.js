import { logger } from "../config/logger.js";
import { subscribe } from "./eventBus.js";

// Event subscribers, one line per handler. The bus runs each at least once per
// event, so every handler is idempotent (dedupe keys on the eventId or entity).

const ORDER_TEMPLATES = {
  placed: "order.placed",
  accepted: "order.accepted",
  preparing: "order.preparing",
  ready: "order.ready",
  dispatched: "order.dispatched",
  delivered: "order.delivered",
  cancelled: "order.cancelled",
};

const ANALYTICS_NAMES = {
  "order.placed": "order_placed",
  "payment.captured": "payment_succeeded",
  "payment.failed": "payment_failed",
  "order.rated": "rating_submitted",
  "user.registered": "user_registered",
  "reward.earned": "points_earned",
  "reward.redeemed": "reward_redeemed",
  "subscription.activated": "subscription_purchased",
  "subscription.renewed": "subscription_renewed",
  "subscription.renewal_failed": "subscription_renewal_failed",
  "subscription.pause_scheduled": "subscription_paused",
  "subscription.resumed": "subscription_resumed",
  "subscription.cancel_scheduled": "subscription_cancelled",
  "subscription.cancel_undone": "cancel_undone",
  "meal.shifted": "meal_shifted",
  "referral.converted": "referral_converted",
  "ticket.created": "ticket_created",
};
const STATUS_ANALYTICS = { accepted: "order_accepted", ready: "order_prepared", dispatched: "order_dispatched", delivered: "order_delivered", cancelled: "order_cancelled" };

const rupees = (paise) => (Number(paise || 0) / 100).toFixed(2).replace(/\.00$/, "");

async function orderData(orderId) {
  const { Order } = await import("../modules/order/order.model.js");
  const order = await Order.findById(orderId).lean();
  if (!order) return null;
  return {
    order: {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      kitchenName: order.kitchenName,
      total: rupees(order.bill?.grandTotalPaise),
      pickupSuffix: order.deliveryMode === "pickup" ? " for pickup" : "",
      refundNote: order.paymentStatus === "paid" || order.refundedPaise ? "Your refund is on its way." : "",
    },
    raw: order,
  };
}

export async function registerEventHandlers() {
  subscribe("settings.*", "log.settings", async (event) => {
    logger.info({ event: event.name, ...event.payload }, "Settings event");
  });

  // ---- notifications
  subscribe("order.status_changed", "notify.order_status", async (event) => {
    const template = ORDER_TEMPLATES[event.payload.to];
    if (!template) return;
    const data = await orderData(event.payload.orderId);
    if (!data) return;
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: template, data, dedupeKey: `order:${event.payload.orderId}:${event.payload.to}` });
  });
  subscribe("payment.failed", "notify.payment_failed", async (event) => {
    if (event.payload.refType !== "order") return;
    const data = await orderData(event.payload.refId);
    if (!data || data.raw.status !== "payment_pending") return;
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: "payment.failed", data, dedupeKey: `payment:${event.payload.paymentId}:failed` });
  });
  subscribe("refund.processed", "notify.refund", async (event) => {
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: "refund.processed", data: { refund: { amount: rupees(event.payload.amountPaise) } }, dedupeKey: `refund:${event.payload.refundId}` });
  });
  subscribe("reward.earned", "notify.reward", async (event) => {
    if (["cancellation", "admin"].includes(event.payload.source)) return;
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: "reward.earned", data: { reward: { points: event.payload.points, title: event.payload.source === "order" ? "For your delivered order" : event.payload.source === "review" ? "For rating your order" : event.payload.source === "referral" ? "Referral reward" : event.payload.source === "birthday" ? "Happy birthday from MealJi" : "Points added" } }, dedupeKey: `reward:${event.eventId}` });
  });
  subscribe("user.first_login", "notify.welcome", async (event) => {
    if (event.payload.role !== "user") return;
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: "auth.welcome", dedupeKey: `welcome:${event.payload.userId}` });
  });
  subscribe("user.phone_changed", "notify.phone_changed", async (event) => {
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: "account.phone_changed", dedupeKey: `phone:${event.eventId}` });
  });

  subscribe("ticket.updated", "notify.ticket", async (event) => {
    const { notify } = await import("../modules/notification/notification.service.js");
    await notify({ userId: event.payload.userId, templateKey: "support.ticket_update", data: { ticket: { ticketId: event.payload.ticketId, number: event.payload.number, status: String(event.payload.status || "").replace("_", " "), message: event.payload.message || "" } }, dedupeKey: `ticket:${event.eventId}` });
  });

  // ---- delivery
  subscribe("order.status_changed", "delivery.auto_book", async (event) => {
    const { onOrderStatus } = await import("../modules/delivery/delivery.service.js");
    await onOrderStatus(event.payload);
  });

  // ---- loyalty
  subscribe("order.delivered", "loyalty.order_points", async (event) => {
    const { resolveSetting } = await import("../modules/settings/settings.service.js");
    const loyalty = (await resolveSetting("loyalty")).values;
    if (!loyalty.enabled || !loyalty.pointsPerOrder) return;
    const { earnPoints } = await import("../modules/rewards/ledger.service.js");
    await earnPoints({ userId: event.payload.userId, points: loyalty.pointsPerOrder, source: "order", title: "Order delivered", referenceType: "order", referenceId: event.payload.orderId, dedupeKey: `order:${event.payload.orderId}:earn` });
    const { Order } = await import("../modules/order/order.model.js");
    const { KitchenDish } = await import("../modules/catalog/catalog.model.js");
    const order = await Order.findById(event.payload.orderId).select("items").lean();
    for (const item of order?.items || []) {
      for (const part of item.dishIds || []) await KitchenDish.updateOne({ _id: part.dishId }, { $inc: { orderCount: part.qty } });
    }
  });
  // ---- billing: online orders are invoiced when paid; cash orders once delivered.
  subscribe("order.delivered", "billing.cod_invoice", async (event) => {
    if (event.payload.paymentMethod !== "cod") return;
    const { Order } = await import("../modules/order/order.model.js");
    const order = await Order.findById(event.payload.orderId).lean();
    if (!order || order.invoice) return;
    const { invoiceOrder } = await import("../modules/payment/payment.service.js");
    await invoiceOrder(order);
  });
  subscribe("order.cancelled", "loyalty.reverse_points", async (event) => {
    const { reverseEarnedPoints } = await import("../modules/rewards/ledger.service.js");
    await reverseEarnedPoints({ userId: event.payload.userId, referenceId: event.payload.orderId, title: "Order cancelled" });
  });
  subscribe("order.rated", "loyalty.review_points", async (event) => {
    const { resolveSetting } = await import("../modules/settings/settings.service.js");
    const loyalty = (await resolveSetting("loyalty")).values;
    if (!loyalty.enabled || !loyalty.pointsPerReview) return;
    const { earnPoints } = await import("../modules/rewards/ledger.service.js");
    await earnPoints({ userId: event.payload.userId, points: loyalty.pointsPerReview, source: "review", title: "Rated your order", referenceType: "order_rating", referenceId: event.payload.orderId, dedupeKey: `order:${event.payload.orderId}:review` });
  });

  // ---- analytics (server events are the source of truth for money)
  subscribe("*", "analytics.server_events", async (event) => {
    const { recordServerEvent } = await import("../modules/analytics/analytics.service.js");
    let name = ANALYTICS_NAMES[event.name];
    if (event.name === "order.status_changed") name = STATUS_ANALYTICS[event.payload.to];
    if (!name) return;
    await recordServerEvent(name, {
      userId: event.payload.userId || null,
      kitchenId: event.payload.kitchenId || null,
      properties: { ...event.payload, value: event.payload.totalPaise ?? event.payload.amountPaise ?? null },
      eventId: `${event.eventId}:${name}`,
    });
  });

  // ---- later phases register their own handlers
  await registerModuleHandlers();
}

async function registerModuleHandlers() {
  const modules = [
    "../modules/subscription/subscription.handlers.js",
    "../modules/rewards/rewards.handlers.js",
    "../modules/engagement/engagement.handlers.js",
  ];
  for (const path of modules) {
    try {
      const mod = await import(path);
      mod.registerHandlers?.(subscribe);
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    }
  }
}
