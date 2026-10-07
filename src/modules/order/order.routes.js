import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { idParam, ok, ownKitchen, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { idempotent } from "../../common/middleware/idempotency.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { Invoice } from "../billing/billing.model.js";
import { invoicePdf, toInvoice } from "../billing/billing.service.js";
import { PAYMENT_METHODS } from "../cart/cart.service.js";
import * as delivery from "../delivery/delivery.service.js";
import * as orders from "./order.service.js";

const byOf = (req) => ({ userId: req.auth.userId, role: req.auth.role, name: req.auth.user?.name || null });

// ------------------------------------------------------------------ customer
export const customerOrderRouter = Router();
customerOrderRouter.use(authMiddleware);

customerOrderRouter.post(
  "/",
  body("paymentMethod").isIn(PAYMENT_METHODS).withMessage("Choose a payment method"),
  body("addressId").optional({ values: "null" }).isMongoId(),
  body("deliveryMode").optional().isIn(["delivery", "pickup"]),
  body("tipPaise").optional().isInt({ min: 0, max: 100000 }).toInt(),
  body("usePoints").optional().isBoolean(),
  body("scheduledFor").optional({ values: "null" }).isISO8601(),
  body("platform").optional().isIn(["android", "ios", "web"]),
  validate,
  idempotent(),
  asyncHandler(async (req, res) => ok(res, await orders.placeOrder(req.auth.userId, req.body), "Order created.", 201)),
);
customerOrderRouter.get("/", pageQuery, query("status").optional().isIn(["active", "past"]), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await orders.listMyOrders(req.auth.userId, { page, limit, status: req.query.status }), "Orders fetched.");
}));
customerOrderRouter.get("/:id", idParam(), validate, asyncHandler(async (req, res) => ok(res, orders.toOrder(await orders.getMyOrder(req.auth.userId, req.params.id)), "Order fetched.")));
customerOrderRouter.get("/:id/live", idParam(), validate, asyncHandler(async (req, res) => ok(res, await orders.liveView(req.auth.userId, req.params.id), "Live status.")));
customerOrderRouter.get("/:id/tracking", idParam(), validate, asyncHandler(async (req, res) => ok(res, await orders.trackingView(req.auth.userId, req.params.id), "Tracking.")));
customerOrderRouter.patch("/:id/cancel", idParam(), body("reason").optional().isString().isLength({ max: 200 }), validate, asyncHandler(async (req, res) => (
  ok(res, await orders.cancelMyOrder(req.auth.userId, req.params.id, req.body), "Order cancelled.")
)));
customerOrderRouter.post("/:id/retry-payment", idParam(), validate, idempotent(), asyncHandler(async (req, res) => ok(res, await orders.retryPayment(req.auth.userId, req.params.id), "Payment restarted.")));
customerOrderRouter.post(
  "/:id/rating",
  idParam(),
  body("foodRating").isInt({ min: 1, max: 5 }).toInt(),
  body("deliveryRating").optional({ values: "null" }).isInt({ min: 1, max: 5 }).toInt(),
  body("tags").optional().isArray({ max: 10 }),
  body("comment").optional({ values: "null" }).isString().isLength({ max: 500 }),
  body("dishRatings").optional().isArray({ max: 20 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await orders.rateOrder(req.auth.userId, req.params.id, req.body), "Thanks for rating.")),
);
customerOrderRouter.post("/:id/reorder", idParam(), validate, asyncHandler(async (req, res) => ok(res, await orders.reorder(req.auth.userId, req.params.id), "Added to your cart.")));
customerOrderRouter.get("/:id/receipt", idParam(), query("format").optional().isIn(["json", "pdf"]), validate, asyncHandler(async (req, res) => {
  const order = await orders.getMyOrder(req.auth.userId, req.params.id);
  const invoice = order.invoice ? await Invoice.findById(order.invoice).lean() : null;
  if (!invoice) throw new AppError(404, "The receipt is issued once the order is paid");
  if (req.query.format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber.replace(/\//g, "-")}.pdf"`);
    return res.send(invoicePdf(invoice));
  }
  return ok(res, toInvoice(invoice), "Receipt fetched.");
}));

// ------------------------------------------------------------------ kitchen desk
export const kitchenOrderRouter = Router();
kitchenOrderRouter.use(authMiddleware, authorize("kitchen.desk"), ownKitchen);

kitchenOrderRouter.get(
  "/",
  authorize("kitchen.orders"),
  pageQuery,
  query("scope").optional().isIn(["active", "new", "history"]),
  query("date").optional().isISO8601({ strict: true }),
  validate,
  asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query, { defaultLimit: 50 });
    return ok(res, await orders.listKitchenOrders(req.kitchenId, { scope: req.query.scope || "active", date: req.query.date, page, limit }), "Orders fetched.");
  }),
);
kitchenOrderRouter.get("/summary", authorize("kitchen.orders"), asyncHandler(async (req, res) => ok(res, await orders.kitchenSummary(req.kitchenId), "Today's summary.")));
kitchenOrderRouter.patch(
  "/:id/status",
  authorize("kitchen.orders"),
  idParam(),
  body("status").isIn(["accepted", "preparing", "ready", "dispatched", "delivered", "cancelled"]),
  body("reason").optional({ values: "null" }).isString().isLength({ max: 200 }),
  validate,
  asyncHandler(async (req, res) => {
    const data = await orders.kitchenSetStatus(req.kitchenId, req.params.id, req.body, byOf(req));
    if (req.body.status === "cancelled") {
      await recordAudit(req, { action: "order.rejected", entityType: "order", entityId: data.orderId, kitchenId: req.kitchenId, summary: `Rejected order ${data.orderNumber}`, reason: req.body.reason, diff: false });
    }
    return ok(res, data, "Order updated.");
  }),
);
kitchenOrderRouter.patch(
  "/:id/step",
  authorize("kitchen.orders"),
  idParam(),
  body("stepKey").isString().isLength({ max: 40 }),
  body("state").isIn(["active", "done"]),
  validate,
  asyncHandler(async (req, res) => ok(res, await orders.setKitchenStep(req.kitchenId, req.params.id, req.body), "Step updated.")),
);
kitchenOrderRouter.patch(
  "/:id/delivery",
  authorize("kitchen.delivery"),
  idParam(),
  body("action").isIn(["book", "rebook", "assign_rider", "picked_up", "delivered", "cancel"]),
  body("rider.name").optional().isString().isLength({ max: 80 }),
  body("rider.phone").optional({ values: "falsy" }).matches(/^[6-9]\d{9}$/).withMessage("Invalid rider phone"),
  body("rider.vehicleNumber").optional({ values: "null" }).isString().isLength({ max: 20 }),
  body("provider").optional().isIn(["manual", "self"]),
  body("reason").optional().isString().isLength({ max: 200 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await delivery.kitchenDeliveryAction(req.kitchenId, req.params.id, req.body), "Delivery updated.")),
);

kitchenOrderRouter.post(
  "/:id/rider-location",
  authorize("kitchen.delivery"),
  idParam(),
  body("lat").isFloat({ min: -90, max: 90 }).toFloat(),
  body("lng").isFloat({ min: -180, max: 180 }).toFloat(),
  body("heading").optional().isFloat().toFloat(),
  body("speed").optional().isFloat().toFloat(),
  validate,
  asyncHandler(async (req, res) => ok(res, await delivery.updateRiderLocation(req.kitchenId, req.params.id, req.body), "Location updated.")),
);

// ------------------------------------------------------------------ admin
export const adminOrderRouter = Router();
adminOrderRouter.use(authMiddleware);

adminOrderRouter.get(
  "/orders",
  authorize("orders.read"),
  pageQuery,
  query("status").optional().isIn(["active", "payment_pending", "payment_failed", "placed", "accepted", "preparing", "ready", "dispatched", "delivered", "cancelled"]),
  query("kitchenId").optional({ values: "falsy" }).isMongoId(),
  query("userId").optional({ values: "falsy" }).isMongoId(),
  query("paymentStatus").optional({ values: "falsy" }).isIn(["pending", "paid", "failed", "cod_pending", "cod_collected", "refunded", "partially_refunded"]),
  query("paymentMethod").optional({ values: "falsy" }).isIn(["upi", "card", "netbanking", "wallet", "cod"]),
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("q").optional().isString().isLength({ max: 40 }),
  validate,
  asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query);
    return ok(res, await orders.listOrders({ ...req.query, page, limit }), "Orders fetched.");
  }),
);
adminOrderRouter.get("/orders/:id", authorize("orders.read"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await orders.getOrderAdmin(req.params.id), "Order fetched.")));
adminOrderRouter.patch(
  "/orders/:id/status",
  authorize("orders.manage"),
  idParam(),
  body("status").isIn(["accepted", "preparing", "ready", "dispatched", "delivered"]),
  body("reason").optional({ values: "null" }).isString().isLength({ max: 200 }),
  validate,
  asyncHandler(async (req, res) => {
    const data = await orders.adminSetStatus(req.params.id, req.body, byOf(req));
    await recordAudit(req, { action: "order.status_overridden", entityType: "order", entityId: data.orderId, kitchenId: data.kitchen.kitchenId, summary: `${data.orderNumber} moved to ${data.status}`, reason: req.body.reason || null, after: { status: data.status }, diff: false });
    return ok(res, data, "Order updated.");
  }),
);
adminOrderRouter.post(
  "/orders/:id/cancel",
  authorize("orders.manage"),
  idParam(),
  body("reason").isString().trim().isLength({ min: 3, max: 200 }).withMessage("Give a reason"),
  body("refund").optional().isIn(["full", "partial", "none"]),
  body("amountPaise").optional().isInt({ min: 1 }).toInt(),
  validate,
  asyncHandler(async (req, res) => {
    if (req.body.refund && req.body.refund !== "none" && !req.auth.permissions.includes("refunds.create")) throw new AppError(403, "You cannot start refunds");
    const data = await orders.adminCancel(req.params.id, req.body, { ...byOf(req), permissions: req.auth.permissions });
    await recordAudit(req, { action: "order.cancelled", entityType: "order", entityId: data.order.orderId, kitchenId: data.order.kitchen.kitchenId, summary: `Cancelled ${data.order.orderNumber}${data.refund ? `, refund ₹${(data.refund.amountPaise / 100).toFixed(2)} ${data.refund.status}` : ""}`, reason: req.body.reason, diff: false });
    return ok(res, data, "Order cancelled.");
  }),
);

adminOrderRouter.get(
  "/deliveries",
  authorize("delivery.manage"),
  pageQuery,
  query("status").optional().isIn(["pending", "booked", "assigned", "picked_up", "delivered", "cancelled", "failed"]),
  query("kitchenId").optional({ values: "falsy" }).isMongoId(),
  validate,
  asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query);
    return ok(res, await delivery.listJobs({ ...req.query, page, limit }), "Deliveries fetched.");
  }),
);
adminOrderRouter.get("/delivery-providers", authorize("delivery.manage"), asyncHandler(async (req, res) => ok(res, await delivery.providerOverview(), "Providers fetched.")));
const accountBody = (optional) => [
  (optional ? body("provider").optional() : body("provider")).isString().trim().matches(/^[a-z0-9_]{2,30}$/).withMessage("Provider key: 2-30 lowercase letters, digits or _"),
  (optional ? body("name").optional() : body("name")).isString().trim().isLength({ min: 2, max: 80 }).withMessage("Name: 2-80 characters"),
  body("credentials").optional().isObject().withMessage("credentials must be an object"),
  body("cities").optional().isArray({ max: 50 }),
  body("cities.*").optional().isString().isLength({ max: 60 }),
  body("kitchenIds").optional().isArray({ max: 500 }),
  body("kitchenIds.*").optional().isMongoId(),
  body("isActive").optional().isBoolean(),
];
adminOrderRouter.post("/delivery-providers/accounts", authorize("settings.delivery"), accountBody(false), validate, asyncHandler(async (req, res) => {
  const data = await delivery.saveProviderAccount(null, req.body);
  await recordAudit(req, { action: "delivery.account_created", entityType: "delivery_account", entityId: data.accountId, summary: `Added delivery partner account ${data.name}`, diff: false });
  return ok(res, data, "Account added.", 201);
}));
adminOrderRouter.patch("/delivery-providers/accounts/:id", authorize("settings.delivery"), idParam(), accountBody(true), validate, asyncHandler(async (req, res) => ok(res, await delivery.saveProviderAccount(req.params.id, req.body), "Account saved.")));
adminOrderRouter.post(
  "/deliveries/:id/:action",
  authorize("delivery.manage"),
  idParam(),
  param("action").isIn(["rebook", "cancel", "assign_rider", "picked_up", "delivered", "set_cost"]),
  validate,
  asyncHandler(async (req, res) => {
    const data = await delivery.adminJobAction(req.params.id, { action: req.params.action, ...req.body });
    await recordAudit(req, { action: `delivery.${req.params.action}`, entityType: "delivery", entityId: data.jobId, kitchenId: data.kitchenId, summary: `Delivery ${data.orderNumber || data.jobId}: ${req.params.action.replace("_", " ")}`, reason: req.body.reason || null, diff: false });
    return ok(res, data, "Delivery updated.");
  }),
);
