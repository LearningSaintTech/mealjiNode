import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { fetchPayment, gatewayName, refundPayment, verifyPaymentSignature, verifyWebhookSignature } from "../../infrastructure/payments/gateway.js";
import { publish } from "../../realtime/hub.js";
import { invoiceLinesFromBill, issueInvoice } from "../billing/billing.service.js";
import { confirmRedemption } from "../coupon/coupon.service.js";
import { Order } from "../order/order.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Payment, Refund, WebhookEvent } from "./payment.model.js";

// ------------------------------------------------------------------ capture

/** Issues the GST invoice for an order (idempotent: one invoice per order). */
export async function invoiceOrder(order) {
  try {
    const invoice = await issueInvoice({
      refType: "order",
      refId: order._id,
      userId: order.user,
      kitchenId: order.kitchen,
      customer: { name: order.customer?.name, phone: order.customer?.phone, address: order.address?.fullAddress || null, state: order.address?.state || null },
      lines: invoiceLinesFromBill(order.bill, order.items),
      totals: {
        taxablePaise: order.bill.taxes.lines.reduce((sum, line) => sum + line.taxablePaise, 0),
        cgstPaise: order.bill.taxes.cgst,
        sgstPaise: order.bill.taxes.sgst,
        igstPaise: order.bill.taxes.igst,
        totalPaise: order.bill.taxes.lines.reduce((sum, line) => sum + line.taxablePaise + line.total, 0),
      },
      placeOfSupply: order.address?.state || null,
    });
    if (invoice) await Order.updateOne({ _id: order._id }, { $set: { invoice: invoice._id } });
    return invoice;
  } catch (err) {
    logger.error({ err: err.message, orderId: String(order._id) }, "Invoice could not be issued");
    return null;
  }
}

/**
 * Applies a captured payment (from the app's verify call or the webhook,
 * whichever comes first – both are idempotent).
 */
export async function onPaymentCaptured(payment, { gatewayPaymentId = null, method = null, raw = null } = {}) {
  const claimed = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ["created", "failed"] } },
    { $set: { status: "captured", capturedAt: new Date(), gatewayPaymentId: gatewayPaymentId || payment.gatewayPaymentId, ...(method ? { method } : {}), ...(raw ? { raw } : {}), failureReason: null } },
    { new: true },
  );
  if (!claimed) return Payment.findById(payment._id).lean();
  await publishEventSafe("payment.captured", { paymentId: String(claimed._id), refType: claimed.refType, refId: String(claimed.refId), userId: String(claimed.user), amountPaise: claimed.amountPaise, method: claimed.method }, { aggregate: { type: "payment", id: claimed._id } });
  publish(`user:${claimed.user}`, "payment:status", { refType: claimed.refType, refId: String(claimed.refId), status: "captured" });

  if (claimed.refType === "order") {
    const { transition } = await import("../order/order.service.js");
    const order = await Order.findById(claimed.refId);
    if (!order) return claimed;
    if (["payment_pending", "payment_failed"].includes(order.status)) {
      if (order.status === "payment_failed") {
        await transition(order._id, "payment_pending", { actor: "system", note: "Late payment received" });
      }
      await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: "paid" } });
      await transition(order._id, "placed", { actor: "system", note: "Payment received" });
      await confirmRedemption(order._id);
      const policy = (await resolveSetting("order_policy", { kitchenId: order.kitchen })).values;
      if (policy.acceptMode === "auto") await transition(order._id, "accepted", { actor: "system", note: "Accepted automatically" }).catch(() => {});
    } else if (order.status === "cancelled") {
      // Paid after the order was closed: refund it straight away.
      await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: "paid" } });
      await requestRefund({ orderId: order._id, amountPaise: claimed.amountPaise, reason: "Payment received after the order was cancelled", actor: { role: "system" }, permissions: ["refunds.approve"] });
    } else {
      // The order was already paid by another payment (e.g. an old checkout
      // finished after a retry): give this second payment back in full.
      const other = await Payment.exists({ refType: "order", refId: order._id, _id: { $ne: claimed._id }, status: { $in: ["captured", "partially_refunded"] } });
      if (other) {
        await requestRefund({ orderId: order._id, paymentId: claimed._id, amountPaise: claimed.amountPaise, reason: "Duplicate payment for an order that was already paid", actor: { role: "system" }, permissions: ["refunds.approve"], duplicate: true });
        logger.warn({ orderId: String(order._id), paymentId: String(claimed._id) }, "Duplicate payment refunded");
      }
    }
    await invoiceOrder(await Order.findById(order._id).lean());
  } else if (claimed.refType === "subscription") {
    const { onSubscriptionPaymentCaptured } = await import("../subscription/subscription.service.js");
    await onSubscriptionPaymentCaptured(claimed);
  }
  return claimed;
}

export async function onPaymentFailed(payment, reason) {
  const updated = await Payment.findOneAndUpdate({ _id: payment._id, status: "created" }, { $set: { status: "failed", failureReason: reason || "Payment failed" } }, { new: true });
  if (!updated) return;
  await publishEventSafe("payment.failed", { paymentId: String(updated._id), refType: updated.refType, refId: String(updated.refId), userId: String(updated.user), reason }, { aggregate: { type: "payment", id: updated._id } });
  publish(`user:${updated.user}`, "payment:status", { refType: updated.refType, refId: String(updated.refId), status: "failed", reason });
  if (updated.refType === "subscription") {
    const { onSubscriptionPaymentFailed } = await import("../subscription/subscription.service.js");
    await onSubscriptionPaymentFailed(updated, reason);
  }
}

/** POST /payments/verify – the app's fast path after checkout returns. */
export async function verifyFromApp(userId, { gatewayOrderId, gatewayPaymentId, signature }) {
  const payment = await Payment.findOne({ gatewayOrderId, user: userId });
  if (!payment) throw new AppError(404, "Payment not found");
  if (!verifyPaymentSignature({ gatewayOrderId, gatewayPaymentId, signature })) {
    await onPaymentFailed(payment, "Signature mismatch");
    throw new AppError(400, "Payment could not be verified");
  }
  let method = null;
  try {
    method = (await fetchPayment(gatewayPaymentId))?.method || null;
  } catch {
    method = null;
  }
  const captured = await onPaymentCaptured(payment, { gatewayPaymentId, method });
  return { paymentId: String(captured._id), status: captured.status, refType: captured.refType, refId: String(captured.refId) };
}

export async function reportFailureFromApp(userId, { gatewayOrderId, reason }) {
  const payment = await Payment.findOne({ gatewayOrderId, user: userId });
  if (!payment) throw new AppError(404, "Payment not found");
  await onPaymentFailed(payment, reason || "Cancelled by customer");
  return { status: "failed" };
}

// ------------------------------------------------------------------ refunds

export function toRefund(refund) {
  return {
    refundId: String(refund._id),
    orderId: refund.order ? String(refund.order._id || refund.order) : null,
    orderNumber: refund.order?.orderNumber || null,
    subscriptionId: refund.subscription ? String(refund.subscription) : null,
    userId: String(refund.user),
    kitchenId: refund.kitchen ? String(refund.kitchen) : null,
    amountPaise: refund.amountPaise,
    reason: refund.reason,
    status: refund.status,
    gatewayRefundId: refund.gatewayRefundId,
    requestedBy: refund.requestedBy,
    reviewedBy: refund.reviewedBy?.userId ? refund.reviewedBy : null,
    reviewNote: refund.reviewNote,
    processedAt: refund.processedAt,
    failureReason: refund.failureReason,
    duplicatePayment: Boolean(refund.duplicatePayment),
    createdAt: refund.createdAt,
  };
}

async function processRefund(refundId) {
  const refund = await Refund.findById(refundId);
  if (!refund || refund.status !== "processing" || refund.gatewayRefundId) return refund;
  const payment = refund.payment ? await Payment.findById(refund.payment) : null;
  if (!payment || payment.gateway === "cod") {
    // Cash orders are refunded outside the gateway (bank transfer); mark processed.
    refund.status = "processed";
    refund.processedAt = new Date();
    await refund.save();
  } else {
    try {
      const result = await refundPayment({ gatewayPaymentId: payment.gatewayPaymentId, amountPaise: refund.amountPaise, notes: { refundId: String(refund._id) } });
      refund.gatewayRefundId = result.gatewayRefundId;
      if (result.status === "processed") {
        refund.status = "processed";
        refund.processedAt = new Date();
      }
      await refund.save();
    } catch (err) {
      refund.status = "failed";
      refund.failureReason = err.message;
      await refund.save();
      await publishEventSafe("refund.failed", { refundId: String(refund._id), reason: err.message });
      return refund;
    }
  }
  if (refund.status === "processed") await afterRefundProcessed(refund);
  return refund;
}

async function afterRefundProcessed(refund) {
  if (refund.payment) {
    const payment = await Payment.findById(refund.payment);
    if (payment) {
      payment.refundedPaise = (payment.refundedPaise || 0) + refund.amountPaise;
      payment.status = payment.refundedPaise >= payment.amountPaise ? "refunded" : "partially_refunded";
      await payment.save();
    }
  }
  // Giving back a duplicate payment does not refund the order (it is still paid once).
  if (refund.order && !refund.duplicatePayment) {
    const order = await Order.findById(refund.order);
    if (order) {
      order.refundedPaise = (order.refundedPaise || 0) + refund.amountPaise;
      order.paymentStatus = order.refundedPaise >= order.bill.grandTotalPaise ? "refunded" : "partially_refunded";
      await order.save();
    }
  }
  await publishEventSafe("refund.processed", { refundId: String(refund._id), orderId: refund.order ? String(refund.order) : null, subscriptionId: refund.subscription ? String(refund.subscription) : null, userId: String(refund.user), amountPaise: refund.amountPaise }, { aggregate: { type: "refund", id: refund._id } });
}

/**
 * Starts a refund. Amounts above the support limit (order policy) wait for
 * someone with refunds.approve, unless the requester holds it.
 */
export async function requestRefund({ orderId = null, subscriptionId = null, paymentId = null, amountPaise, reason, actor, permissions = [], duplicate = false }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new AppError(422, "Refund amount must be paise above 0");
  let payment = paymentId ? await Payment.findById(paymentId) : null;
  let order = null;
  if (orderId) {
    order = await Order.findById(orderId);
    if (!order) throw new AppError(404, "Order not found");
    payment = payment || await Payment.findOne({ refType: "order", refId: order._id, status: { $in: ["captured", "partially_refunded"] } }).sort({ createdAt: -1 });
    const pending = await Refund.aggregate([{ $match: { order: order._id, status: { $in: ["pending_approval", "processing", "processed"] } } }, { $group: { _id: null, total: { $sum: "$amountPaise" } } }]);
    const already = pending[0]?.total || 0;
    const paid = order.paymentMethod === "cod" ? (order.paymentStatus === "cod_collected" ? order.bill.grandTotalPaise : 0) : (payment?.amountPaise || 0);
    if (duplicate) {
      if (amountPaise > (payment?.amountPaise || 0) - (payment?.refundedPaise || 0)) throw new AppError(422, "Refund is more than this payment");
    } else if (amountPaise + already > paid) throw new AppError(422, `At most ₹${((paid - already) / 100).toFixed(2)} can be refunded`);
  } else if (subscriptionId) {
    payment = payment || await Payment.findOne({ refType: "subscription", refId: subscriptionId, status: { $in: ["captured", "partially_refunded"] } }).sort({ createdAt: -1 });
    if (!payment || amountPaise > payment.amountPaise - (payment.refundedPaise || 0)) throw new AppError(422, "Refund is more than what was paid");
  }
  const policy = (await resolveSetting("order_policy", order ? { kitchenId: order.kitchen } : {})).values;
  const canApprove = permissions.includes("refunds.approve");
  const needsApproval = !canApprove && amountPaise > (policy.supportRefundLimitPaise || 0);
  const refund = await Refund.create({
    payment: payment?._id || null,
    order: order?._id || null,
    subscription: subscriptionId || null,
    user: order?.user || payment?.user,
    kitchen: order?.kitchen || null,
    amountPaise,
    reason,
    status: needsApproval ? "pending_approval" : "processing",
    duplicatePayment: Boolean(duplicate),
    requestedBy: { userId: actor?.userId || null, name: actor?.name || null, role: actor?.role || null },
  });
  if (!needsApproval) await processRefund(refund._id);
  return toRefund(await Refund.findById(refund._id).populate("order", "orderNumber").lean());
}

export async function reviewRefund(refundId, { approve, note = null, reviewer }) {
  const refund = await Refund.findOneAndUpdate(
    { _id: objectId(refundId, "refund ID"), status: "pending_approval" },
    { $set: { status: approve ? "processing" : "rejected", reviewedBy: { userId: reviewer.userId, name: reviewer.name }, reviewNote: note } },
    { new: true },
  );
  if (!refund) throw new AppError(409, "This refund is not waiting for approval");
  if (approve) await processRefund(refund._id);
  return toRefund(await Refund.findById(refund._id).populate("order", "orderNumber").lean());
}

export async function retryRefund(refundId) {
  const refund = await Refund.findOneAndUpdate({ _id: objectId(refundId, "refund ID"), status: "failed" }, { $set: { status: "processing", failureReason: null, gatewayRefundId: null } }, { new: true });
  if (!refund) throw new AppError(409, "Only failed refunds can be retried");
  await processRefund(refund._id);
  return toRefund(await Refund.findById(refund._id).populate("order", "orderNumber").lean());
}

// ------------------------------------------------------------------ webhooks

/**
 * Razorpay webhook (authoritative). Verifies the signature on the raw body,
 * stores the event once (dedupe by event id) and applies it idempotently.
 */
export async function handleGatewayWebhook(rawBody, signature, eventIdHeader) {
  if (!verifyWebhookSignature(rawBody, signature)) throw new AppError(401, "Invalid signature");
  const body = JSON.parse(rawBody.toString("utf8"));
  const eventId = eventIdHeader || body.id || `${body.event}:${body.payload?.payment?.entity?.id || body.payload?.refund?.entity?.id || Date.now()}`;
  let record;
  try {
    record = await WebhookEvent.create({ provider: gatewayName(), eventId, type: body.event, payload: body });
  } catch (err) {
    if (err?.code === 11000) return { duplicate: true };
    throw err;
  }
  try {
    const result = await applyWebhook(body);
    record.status = result === "ignored" ? "ignored" : "processed";
    record.processedAt = new Date();
    await record.save();
    return { processed: true };
  } catch (err) {
    record.status = "failed";
    record.error = err.message;
    await record.save();
    // Remove so the provider's retry is processed again.
    await WebhookEvent.deleteOne({ _id: record._id });
    throw err;
  }
}

async function applyWebhook(body) {
  const paymentEntity = body.payload?.payment?.entity;
  const refundEntity = body.payload?.refund?.entity;
  switch (body.event) {
    case "payment.captured":
    case "order.paid": {
      const payment = await Payment.findOne({ gatewayOrderId: paymentEntity?.order_id });
      if (!payment) return "ignored";
      await onPaymentCaptured(payment, { gatewayPaymentId: paymentEntity.id, method: paymentEntity.method, raw: { fee: paymentEntity.fee, tax: paymentEntity.tax } });
      if (paymentEntity.fee != null) await Payment.updateOne({ _id: payment._id }, { $set: { feePaise: paymentEntity.fee || 0, taxOnFeePaise: paymentEntity.tax || 0 } });
      return "processed";
    }
    case "payment.failed": {
      const payment = await Payment.findOne({ gatewayOrderId: paymentEntity?.order_id });
      if (!payment) return "ignored";
      await onPaymentFailed(payment, paymentEntity?.error_description || "Payment failed");
      return "processed";
    }
    case "refund.processed": {
      const refund = await Refund.findOne({ gatewayRefundId: refundEntity?.id });
      if (!refund || refund.status === "processed") return "ignored";
      refund.status = "processed";
      refund.processedAt = new Date();
      await refund.save();
      await afterRefundProcessed(refund);
      return "processed";
    }
    case "refund.failed": {
      await Refund.updateOne({ gatewayRefundId: refundEntity?.id }, { $set: { status: "failed", failureReason: "Refund failed at the gateway" } });
      return "processed";
    }
    case "payment_link.paid":
    case "subscription.charged":
    case "subscription.halted":
    case "subscription.cancelled":
    case "subscription.activated": {
      const { onSubscriptionWebhook } = await import("../subscription/subscription.service.js");
      return onSubscriptionWebhook(body);
    }
    default:
      return "ignored";
  }
}

// ------------------------------------------------------------------ admin lists & reconciliation

export async function listPayments({ status, refType, gateway, from, to, q, page = 1, limit = 25 }) {
  const filter = {};
  if (status) filter.status = status;
  if (refType) filter.refType = refType;
  if (gateway) filter.gateway = gateway;
  if (q) filter.$or = [{ gatewayPaymentId: q }, { gatewayOrderId: q }];
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to) filter.createdAt.$lte = new Date(to);
  }
  const [items, total, sums] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("user", "name phoneNumber").lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([{ $match: { ...filter, status: { $in: ["captured", "partially_refunded", "refunded"] } } }, { $group: { _id: null, capturedPaise: { $sum: "$amountPaise" }, refundedPaise: { $sum: "$refundedPaise" }, feePaise: { $sum: "$feePaise" } } }]),
  ]);
  const orderIds = items.filter((payment) => payment.refType === "order").map((payment) => payment.refId);
  const orderNumbers = new Map((await Order.find({ _id: { $in: orderIds } }).select("orderNumber").lean()).map((order) => [String(order._id), order.orderNumber]));
  return {
    items: items.map((payment) => ({
      paymentId: String(payment._id),
      refType: payment.refType,
      refId: String(payment.refId),
      refLabel: payment.refType === "order" ? orderNumbers.get(String(payment.refId)) || null : `Cycle ${payment.cycle || 1}`,
      user: payment.user ? { userId: String(payment.user._id), name: payment.user.name, phone: payment.user.phoneNumber } : null,
      amountPaise: payment.amountPaise,
      method: payment.method,
      gateway: payment.gateway,
      gatewayOrderId: payment.gatewayOrderId,
      gatewayPaymentId: payment.gatewayPaymentId,
      status: payment.status,
      failureReason: payment.failureReason,
      feePaise: payment.feePaise || 0,
      refundedPaise: payment.refundedPaise || 0,
      settlementId: payment.settlementId,
      capturedAt: payment.capturedAt,
      createdAt: payment.createdAt,
    })),
    totals: sums[0] ? { capturedPaise: sums[0].capturedPaise, refundedPaise: sums[0].refundedPaise, feePaise: sums[0].feePaise } : { capturedPaise: 0, refundedPaise: 0, feePaise: 0 },
    page,
    limit,
    total,
  };
}

export async function listRefunds({ status, kitchenId, page = 1, limit = 25 }) {
  const filter = {};
  if (status) filter.status = status;
  if (kitchenId) filter.kitchen = new mongoose.Types.ObjectId(String(kitchenId));
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("order", "orderNumber").lean(),
    Refund.countDocuments(filter),
  ]);
  return { items: items.map(toRefund), page, limit, total };
}

/**
 * Daily: compares local captured payments with the gateway for the previous
 * day and flags mismatches (amount or status). Returns the mismatch count.
 */
export async function reconcilePayments({ since = new Date(Date.now() - 36 * 3600_000) } = {}) {
  const payments = await Payment.find({ gateway: "razorpay", createdAt: { $gte: since }, gatewayPaymentId: { $ne: null } }).limit(2000);
  let mismatches = 0;
  for (const payment of payments) {
    try {
      const remote = await fetchPayment(payment.gatewayPaymentId);
      const remoteCaptured = remote.status === "captured" || remote.status === "refunded";
      if (remoteCaptured && payment.status === "failed") {
        await onPaymentCaptured(payment, { gatewayPaymentId: remote.id, method: remote.method });
        mismatches += 1;
      } else if (remote.amount !== payment.amountPaise) {
        mismatches += 1;
        logger.warn({ paymentId: String(payment._id), local: payment.amountPaise, remote: remote.amount }, "Payment amount mismatch");
      }
    } catch (err) {
      logger.warn({ err: err.message, paymentId: String(payment._id) }, "Reconciliation lookup failed");
    }
  }
  if (mismatches) await publishEventSafe("payments.reconciliation_mismatch", { mismatches });
  return mismatches;
}

