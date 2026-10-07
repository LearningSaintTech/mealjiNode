import express, { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { has, idParam, ok, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { idempotent } from "../../common/middleware/idempotency.js";
import { validate } from "../../common/middleware/validate.js";
import { env } from "../../config/env.js";
import { gatewayName, signTestWebhook, simulateTestPayment } from "../../infrastructure/payments/gateway.js";
import { recordAudit } from "../audit/audit.service.js";
import { Payment } from "./payment.model.js";
import * as payments from "./payment.service.js";

// Customer: verify after checkout, or report a failed/closed checkout.
export const paymentRouter = Router();
paymentRouter.post(
  "/verify",
  authMiddleware,
  body("gatewayOrderId").isString().isLength({ min: 4, max: 80 }),
  body("gatewayPaymentId").isString().isLength({ min: 4, max: 80 }),
  body("signature").isString().isLength({ min: 10, max: 200 }),
  validate,
  idempotent(),
  asyncHandler(async (req, res) => ok(res, await payments.verifyFromApp(req.auth.userId, req.body), "Payment verified.")),
);
paymentRouter.post(
  "/failed",
  authMiddleware,
  body("gatewayOrderId").isString().isLength({ min: 4, max: 80 }),
  body("reason").optional().isString().isLength({ max: 200 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await payments.reportFailureFromApp(req.auth.userId, req.body), "Payment marked failed.")),
);

// Development stand-in for the gateway's checkout and hosted pages.
paymentRouter.post(
  "/test/complete",
  authMiddleware,
  body("gatewayOrderId").isString(),
  body("outcome").optional().isIn(["success", "failure"]),
  validate,
  asyncHandler(async (req, res) => {
    if (gatewayName() !== "test" || env.isProd) throw new AppError(404, "Not found");
    const payment = await Payment.findOne({ gatewayOrderId: req.body.gatewayOrderId, user: req.auth.userId });
    if (!payment) throw new AppError(404, "Payment not found");
    if (req.body.outcome === "failure") return ok(res, await payments.reportFailureFromApp(req.auth.userId, { gatewayOrderId: payment.gatewayOrderId, reason: "Declined (test)" }), "Test payment failed.");
    const signed = simulateTestPayment(payment.gatewayOrderId);
    return ok(res, { ...signed, verified: await payments.verifyFromApp(req.auth.userId, signed) }, "Test payment completed.");
  }),
);
paymentRouter.get("/test/links/:id", param("id").isString(), validate, asyncHandler(async (req, res) => {
  if (gatewayName() !== "test" || env.isProd) throw new AppError(404, "Not found");
  const payment = await Payment.findOne({ gatewayLinkId: req.params.id });
  if (!payment) throw new AppError(404, "Payment link not found");
  // Simulates paying the hosted link (as the payment_link.paid webhook would).
  const { onSubscriptionWebhook } = await import("../subscription/subscription.service.js");
  await onSubscriptionWebhook({ event: "payment_link.paid", payload: { payment_link: { entity: { id: req.params.id } }, payment: { entity: { id: `pay_test_link_${Date.now()}`, method: "upi" } } } });
  res.type("html").send("<!doctype html><title>MealJi test payment</title><p style=\"font-family:sans-serif\">Test payment received. You can close this page.</p>");
}));

// Webhooks: mounted before the JSON parser so the signature is checked on raw bytes.
export const webhookRouter = Router();
webhookRouter.post("/razorpay", express.raw({ type: "*/*", limit: "1mb" }), asyncHandler(async (req, res) => {
  const result = await payments.handleGatewayWebhook(req.body, String(req.headers["x-razorpay-signature"] || ""), req.headers["x-razorpay-event-id"] || null);
  return ok(res, result, "Received.");
}));
// Development helper: signs a webhook body with the test secret.
webhookRouter.post("/razorpay/test-sign", express.json(), asyncHandler(async (req, res) => {
  if (gatewayName() !== "test" || env.isProd) throw new AppError(404, "Not found");
  const raw = JSON.stringify(req.body);
  return ok(res, { body: raw, signature: signTestWebhook(Buffer.from(raw)) }, "Signed.");
}));

// Admin: payments, refunds and approvals.
export const adminPaymentRouter = Router();
adminPaymentRouter.use(authMiddleware);
adminPaymentRouter.get(
  "/payments",
  authorize("payments.read"),
  pageQuery,
  query("status").optional().isIn(["created", "captured", "failed", "refunded", "partially_refunded", "cancelled"]),
  query("refType").optional().isIn(["order", "subscription"]),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  validate,
  asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query);
    return ok(res, await payments.listPayments({ ...req.query, page, limit }), "Payments fetched.");
  }),
);
adminPaymentRouter.get(
  "/refunds",
  (req, res, next) => (has(req, "payments.read") || has(req, "refunds.approve") || has(req, "refunds.create") ? next() : next(new AppError(403, "You do not have permission to perform this action"))),
  pageQuery,
  query("status").optional().isIn(["pending_approval", "processing", "processed", "failed", "rejected"]),
  validate,
  asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query);
    return ok(res, await payments.listRefunds({ ...req.query, page, limit }), "Refunds fetched.");
  }),
);
adminPaymentRouter.post(
  "/orders/:id/refunds",
  authorize("refunds.create"),
  idParam(),
  body("amountPaise").isInt({ min: 1 }).toInt(),
  body("reason").isString().trim().isLength({ min: 3, max: 300 }).withMessage("Give a reason"),
  validate,
  idempotent(),
  asyncHandler(async (req, res) => {
    const actor = { userId: req.auth.userId, name: req.auth.user?.name, role: req.auth.role };
    const data = await payments.requestRefund({ orderId: req.params.id, amountPaise: req.body.amountPaise, reason: req.body.reason, actor, permissions: req.auth.permissions });
    await recordAudit(req, { action: "refund.requested", entityType: "order", entityId: req.params.id, kitchenId: data.kitchenId, summary: `Refund of ₹${(data.amountPaise / 100).toFixed(2)} ${data.status === "pending_approval" ? "waiting for approval" : "started"}`, reason: req.body.reason, after: { amountPaise: data.amountPaise, status: data.status }, diff: false });
    return ok(res, data, data.status === "pending_approval" ? "Refund sent for approval." : "Refund started.", 201);
  }),
);
adminPaymentRouter.post(
  "/refunds/:id/:decision",
  authorize("refunds.approve"),
  idParam(),
  param("decision").isIn(["approve", "reject", "retry"]),
  body("note").optional({ values: "null" }).isString().isLength({ max: 300 }),
  validate,
  asyncHandler(async (req, res) => {
    const reviewer = { userId: req.auth.userId, name: req.auth.user?.name };
    const data = req.params.decision === "retry"
      ? await payments.retryRefund(req.params.id)
      : await payments.reviewRefund(req.params.id, { approve: req.params.decision === "approve", note: req.body.note || null, reviewer });
    await recordAudit(req, { action: `refund.${req.params.decision === "approve" ? "approved" : req.params.decision === "reject" ? "rejected" : "retried"}`, entityType: "refund", entityId: data.refundId, kitchenId: data.kitchenId, summary: `Refund ₹${(data.amountPaise / 100).toFixed(2)} ${data.status}`, reason: req.body.note || null, diff: false, after: { status: data.status } });
    return ok(res, data, "Refund updated.");
  }),
);
