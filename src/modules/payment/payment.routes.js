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
import { gatewayName, signTestWebhook, simulateTestPayment, verifyPaymentSignature } from "../../infrastructure/payments/gateway.js";
import { recordAudit } from "../audit/audit.service.js";
import { Order } from "../order/order.model.js";
import { Payment } from "./payment.model.js";
import * as payments from "./payment.service.js";

// Customer: verify after checkout, or report a failed/closed checkout.
export const paymentRouter = Router();

// Hosted Razorpay Checkout page for mobile app & web payments
paymentRouter.get("/checkout/:orderId", asyncHandler(async (req, res) => {
  res.removeHeader("Content-Security-Policy");
  res.setHeader(
    "Content-Security-Policy",
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com https://*.razorpay.com; frame-src * https://api.razorpay.com https://*.razorpay.com; connect-src * https://api.razorpay.com https://*.razorpay.com;"
  );
  const order = await Order.findById(req.params.orderId).lean();
  if (!order) return res.status(404).send("Order not found");

  if (order.status !== "payment_pending") {
    return res.send(`<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MealJi - Order Status</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #FFF9F6; color: #111; text-align: center; padding: 20px; }
    .card { background: #fff; padding: 32px 24px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); max-width: 380px; width: 100%; }
    .btn { display: inline-block; background: #FF5A1F; color: #fff; padding: 14px 28px; border-radius: 12px; font-weight: 700; text-decoration: none; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Order Status</h2>
    <p>This order is already <strong>${order.status}</strong>.</p>
    <a href="mealji://order-confirmed?orderId=${order._id}" class="btn">Return to MealJi App</a>
  </div>
</body>
</html>`);
  }

  const payment = await Payment.findOne({ refType: "order", refId: order._id }).sort({ createdAt: -1 }).lean();
  if (!payment) return res.status(404).send("Payment session not found. Please retry from the app.");

  const keyId = env.razorpayKeyId || payment.keyId || "rzp_live_SNy570iZJB6EKv";
  const amountPaise = payment.amountPaise || order.bill?.grandTotalPaise;
  const orderNumber = order.orderNumber;
  const gatewayOrderId = payment.gatewayOrderId;
  const customerName = order.deliveryAddress?.recipientName || "MealJi Customer";
  const customerPhone = order.deliveryAddress?.phone || "";

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pay Order #${orderNumber} - MealJi</title>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #FFF9F6; color: #111; padding: 20px; text-align: center; }
    .card { background: #FFFFFF; border-radius: 24px; padding: 36px 24px; max-width: 420px; width: 100%; box-shadow: 0 10px 32px rgba(255, 90, 31, 0.08); }
    .logo-badge { width: 56px; height: 56px; border-radius: 16px; background: #FF5A1F; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; color: #fff; font-size: 26px; font-weight: 900; }
    .title { font-size: 22px; font-weight: 800; margin: 0 0 6px; color: #111114; }
    .subtitle { font-size: 14px; color: #77777E; margin: 0 0 20px; }
    .amount { font-size: 34px; font-weight: 900; color: #FF5A1F; margin-bottom: 24px; }
    .btn { background: #FF5A1F; color: #fff; border: none; border-radius: 14px; padding: 16px 28px; font-weight: 700; font-size: 16px; cursor: pointer; width: 100%; display: block; box-shadow: 0 6px 16px rgba(255,90,31,0.25); transition: all 0.2s ease; }
    .btn:active { transform: scale(0.98); }
    .status { font-size: 13px; color: #777; margin-top: 16px; line-height: 1.5; }
    .back-link { display: inline-block; margin-top: 18px; color: #FF5A1F; text-decoration: none; font-size: 14px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-badge">M</div>
    <h1 class="title">MealJi Online Payment</h1>
    <p class="subtitle">Order #${orderNumber}</p>
    <div class="amount">₹${(amountPaise / 100).toFixed(2)}</div>
    <button class="btn" id="payButton" onclick="openRazorpay()">Complete Payment</button>
    <p class="status" id="statusText">Opening Razorpay checkout...</p>
    <a href="mealji://order-confirmed?orderId=${order._id}" class="back-link">Return to App</a>
  </div>

  <script>
    var options = {
      key: "${keyId}",
      amount: ${amountPaise},
      currency: "INR",
      name: "MealJi",
      description: "Order #${orderNumber}",
      order_id: "${gatewayOrderId}",
      handler: function (response) {
        document.getElementById('statusText').innerText = 'Verifying payment with MealJi...';
        document.getElementById('payButton').innerText = 'Verifying...';
        document.getElementById('payButton').style.background = '#888';

        fetch('/api/v1/payments/verify-web', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gatewayOrderId: response.razorpay_order_id,
            gatewayPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature
          })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (data && data.success) {
            document.getElementById('statusText').innerText = '🎉 Payment Successful! Returning to MealJi...';
            document.getElementById('payButton').innerText = '✓ Paid Successfully';
            document.getElementById('payButton').style.background = '#00C853';
            setTimeout(function() {
              window.location.href = "mealji://order-confirmed?orderId=${order._id}";
            }, 1200);
          } else {
            document.getElementById('statusText').innerText = 'Verification note: ' + (data?.message || 'Processing order');
            setTimeout(function() {
              window.location.href = "mealji://order-confirmed?orderId=${order._id}";
            }, 1500);
          }
        })
        .catch(function(err) {
          console.error(err);
          window.location.href = "mealji://order-confirmed?orderId=${order._id}";
        });
      },
      modal: {
        ondismiss: function() {
          document.getElementById('statusText').innerText = 'Payment window closed. Tap Complete Payment to try again.';
          document.getElementById('payButton').innerText = 'Complete Payment';
          document.getElementById('payButton').style.background = '#FF5A1F';
        }
      },
      prefill: {
        name: "${customerName}",
        contact: "${customerPhone}"
      },
      theme: { color: "#FF5A1F" }
    };

    var rzp = new Razorpay(options);

    function openRazorpay() {
      try {
        rzp.open();
      } catch(e) {
        console.error('Razorpay open error:', e);
      }
    }

    // Auto-open on load
    window.addEventListener('load', function() {
      setTimeout(openRazorpay, 350);
    });
  </script>
</body>
</html>`);
}));

// Web verification callback for hosted Razorpay checkout
paymentRouter.post(
  "/verify-web",
  body("gatewayOrderId").isString().isLength({ min: 4, max: 80 }),
  body("gatewayPaymentId").isString().isLength({ min: 4, max: 80 }),
  body("signature").isString().isLength({ min: 10, max: 200 }),
  validate,
  asyncHandler(async (req, res) => {
    const { gatewayOrderId, gatewayPaymentId, signature } = req.body;
    const payment = await Payment.findOne({ gatewayOrderId });
    if (!payment) throw new AppError(404, "Payment not found");
    const verified = await payments.verifyFromApp(payment.user, { gatewayOrderId, gatewayPaymentId, signature });
    return ok(res, verified, "Payment verified.");
  }),
);

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
