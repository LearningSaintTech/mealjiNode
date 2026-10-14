import crypto from "node:crypto";
import axios from "axios";
import { AppError } from "../../common/errors/AppError.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * Payment gateway adapter. "razorpay" talks to Razorpay's REST API; "test" is a
 * development stand-in with the same contract (no keys needed): orders, payment
 * signatures, refunds, payment links and subscriptions all behave the same way,
 * so the app and console flows work end to end locally.
 */

const TEST_SECRET = "mealji-test-gateway-secret";

const hmacHex = (secret, value) => crypto.createHmac("sha256", secret).update(value).digest("hex");

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const razorpay = axios.create({ baseURL: "https://api.razorpay.com/v1", timeout: 15000 });

async function rzp(method, url, data) {
  try {
    const response = await razorpay.request({ method, url, data, auth: { username: env.razorpayKeyId, password: env.razorpayKeySecret } });
    return response.data;
  } catch (error) {
    const detail = error?.response?.data?.error?.description || error.message;
    logger.error({ url, status: error?.response?.status, detail }, "Razorpay request failed");
    // The provider's own text stays in the logs; customers get a plain message.
    const failure = new AppError(502, "The payment service is not responding. Please try again.");
    // No answer at all (timeout / network): the call may still have gone through.
    failure.uncertain = !error?.response;
    failure.detail = detail;
    throw failure;
  }
}

const testId = (prefix) => `${prefix}_test_${crypto.randomBytes(7).toString("hex")}`;

export const gatewayName = () => (env.razorpayKeyId && env.razorpayKeySecret ? "razorpay" : "test");

export function assertGatewayAllowed() {
  if (gatewayName() === "test" && env.isProd) throw new AppError(503, "Payments are not configured");
}

/** Creates a gateway order the app opens checkout with. */
export async function createGatewayOrder({ amountPaise, receipt, notes = {} }) {
  assertGatewayAllowed();
  if (gatewayName() === "razorpay") {
    const order = await rzp("post", "/orders", { amount: amountPaise, currency: "INR", receipt: receipt.slice(0, 40), notes });
    return { gateway: "razorpay", gatewayOrderId: order.id, keyId: env.razorpayKeyId, amountPaise, currency: "INR" };
  }
  return { gateway: "test", gatewayOrderId: testId("order"), keyId: "test", amountPaise, currency: "INR" };
}

/** Checks the checkout signature the app sends back after paying. */
export function verifyPaymentSignature({ gatewayOrderId, gatewayPaymentId, signature }) {
  const secret = gatewayName() === "razorpay" ? env.razorpayKeySecret : TEST_SECRET;
  return safeEqual(hmacHex(secret, `${gatewayOrderId}|${gatewayPaymentId}`), signature);
}

/** Development only: what a successful test checkout would return. */
export function simulateTestPayment(gatewayOrderId) {
  if (gatewayName() !== "test") throw new AppError(404, "Not found");
  const gatewayPaymentId = testId("pay");
  return { gatewayOrderId, gatewayPaymentId, signature: hmacHex(TEST_SECRET, `${gatewayOrderId}|${gatewayPaymentId}`) };
}

export async function refundPayment({ gatewayPaymentId, amountPaise, notes = {} }) {
  if (gatewayName() === "razorpay") {
    const refund = await rzp("post", `/payments/${gatewayPaymentId}/refund`, { amount: amountPaise, speed: "normal", notes });
    return { gatewayRefundId: refund.id, status: refund.status === "processed" ? "processed" : "processing" };
  }
  return { gatewayRefundId: testId("rfnd"), status: "processed" };
}

/** A refund already made for this payment with our refund id in its notes (or null). */
export async function findRefund(gatewayPaymentId, refundId) {
  if (gatewayName() !== "razorpay") return null;
  const list = await rzp("get", `/payments/${gatewayPaymentId}/refunds?count=100`);
  const hit = (list?.items || []).find((item) => item?.notes?.refundId === String(refundId));
  return hit ? { gatewayRefundId: hit.id, status: hit.status === "processed" ? "processed" : "processing" } : null;
}

/**
 * The gateway customer that saved cards / UPI belong to (Razorpay needs one for
 * checkout with `save: 1`). Razorpay returns the existing customer for the same
 * contact (fail_existing: 0), so this is safe to call again.
 */
export async function createGatewayCustomer({ name, email, contact }) {
  assertGatewayAllowed();
  if (gatewayName() === "razorpay") {
    const customer = await rzp("post", "/customers", { name: name || "Meal Ji customer", email: email || undefined, contact: contact || undefined, fail_existing: "0" });
    return customer.id;
  }
  return testId("cust");
}

export async function fetchPayment(gatewayPaymentId) {
  if (gatewayName() === "razorpay") return rzp("get", `/payments/${gatewayPaymentId}`);
  return { id: gatewayPaymentId, status: "captured", method: "upi" };
}

/** A hosted payment link (pay-each-cycle subscriptions, failed autopay fallback). */
export async function createPaymentLink({ amountPaise, description, reference, customer = {}, expireBy = null, notes = {} }) {
  assertGatewayAllowed();
  if (gatewayName() === "razorpay") {
    const link = await rzp("post", "/payment_links", {
      amount: amountPaise,
      currency: "INR",
      description: description.slice(0, 2048),
      reference_id: reference.slice(0, 40),
      customer: { name: customer.name, contact: customer.phone, email: customer.email || undefined },
      notify: { sms: true, email: Boolean(customer.email) },
      reminder_enable: true,
      expire_by: expireBy ? Math.floor(new Date(expireBy).getTime() / 1000) : undefined,
      notes,
    });
    return { gatewayLinkId: link.id, shortUrl: link.short_url, status: link.status };
  }
  const id = testId("plink");
  return { gatewayLinkId: id, shortUrl: `${env.publicBaseUrl}/api/v1/payments/test/links/${id}`, status: "created" };
}

/** Autopay mandate (Razorpay Subscriptions) for a plan amount. */
export async function createGatewaySubscription({ planAmountPaise, intervalDays, totalCount = 120, notes = {}, customer = {} }) {
  assertGatewayAllowed();
  if (gatewayName() === "razorpay") {
    const period = intervalDays % 30 === 0 ? "monthly" : intervalDays % 7 === 0 ? "weekly" : "daily";
    const interval = period === "monthly" ? intervalDays / 30 : period === "weekly" ? intervalDays / 7 : intervalDays;
    const plan = await rzp("post", "/plans", { period, interval, item: { name: notes.planName || "MealJi Plus", amount: planAmountPaise, currency: "INR" } });
    const subscription = await rzp("post", "/subscriptions", { plan_id: plan.id, total_count: totalCount, customer_notify: 1, notes, notify_info: { notify_phone: customer.phone } });
    return { gatewaySubscriptionId: subscription.id, shortUrl: subscription.short_url, status: subscription.status, keyId: env.razorpayKeyId };
  }
  const id = testId("sub");
  return { gatewaySubscriptionId: id, shortUrl: `${env.publicBaseUrl}/api/v1/payments/test/subscriptions/${id}`, status: "created", keyId: "test" };
}

export async function cancelGatewaySubscription(gatewaySubscriptionId) {
  if (gatewayName() === "razorpay") return rzp("post", `/subscriptions/${gatewaySubscriptionId}/cancel`, { cancel_at_cycle_end: 1 });
  return { id: gatewaySubscriptionId, status: "cancelled" };
}

/** Closes a payment link so it can no longer be paid (cycle already paid, plan ended, price changed). */
export async function cancelPaymentLink(gatewayLinkId) {
  if (gatewayName() === "razorpay") return rzp("post", `/payment_links/${gatewayLinkId}/cancel`, {});
  return { id: gatewayLinkId, status: "cancelled" };
}

/** Stops autopay charges while a plan is paused (the paid cycle is not affected). */
export async function pauseGatewaySubscription(gatewaySubscriptionId) {
  if (gatewayName() === "razorpay") return rzp("post", `/subscriptions/${gatewaySubscriptionId}/pause`, { pause_at: "now" });
  return { id: gatewaySubscriptionId, status: "paused" };
}

export async function resumeGatewaySubscription(gatewaySubscriptionId) {
  if (gatewayName() === "razorpay") return rzp("post", `/subscriptions/${gatewaySubscriptionId}/resume`, { resume_at: "now" });
  return { id: gatewaySubscriptionId, status: "active" };
}

/** Changes the autopay amount from the next cycle (plan change). */
export async function updateGatewaySubscriptionAmount(gatewaySubscriptionId, { planAmountPaise, intervalDays, planName }) {
  if (gatewayName() === "razorpay") {
    const period = intervalDays % 30 === 0 ? "monthly" : intervalDays % 7 === 0 ? "weekly" : "daily";
    const interval = period === "monthly" ? intervalDays / 30 : period === "weekly" ? intervalDays / 7 : intervalDays;
    const plan = await rzp("post", "/plans", { period, interval, item: { name: planName || "MealJi Plus", amount: planAmountPaise, currency: "INR" } });
    return rzp("patch", `/subscriptions/${gatewaySubscriptionId}`, { plan_id: plan.id, schedule_change_at: "cycle_end" });
  }
  return { id: gatewaySubscriptionId, status: "active", amountPaise: planAmountPaise };
}

/** Verifies a webhook body (raw bytes) against the provider signature. */
export function verifyWebhookSignature(rawBody, signature) {
  if (gatewayName() === "razorpay") {
    if (!env.razorpayWebhookSecret) return false;
    return safeEqual(hmacHex(env.razorpayWebhookSecret, rawBody), signature);
  }
  return safeEqual(hmacHex(TEST_SECRET, rawBody), signature);
}

export function signTestWebhook(rawBody) {
  return hmacHex(TEST_SECRET, rawBody);
}
