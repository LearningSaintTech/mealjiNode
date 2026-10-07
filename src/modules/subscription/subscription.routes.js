import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, has, idParam, ok, ownKitchen, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { idempotent } from "../../common/middleware/idempotency.js";
import { validate } from "../../common/middleware/validate.js";
import { istDateKey } from "../../common/time.js";
import { recordAudit } from "../audit/audit.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { resolveCustomerKitchen } from "../serviceability/serviceability.service.js";
import * as meals from "./mealplan.service.js";
import * as plans from "./plan.service.js";
import * as slots from "./slot.service.js";
import * as subs from "./subscription.service.js";
import { SLOT_KEYS } from "./subscription.model.js";
import "./reports.subscription.js";

const dateParam = param("date").isISO8601({ strict: true }).withMessage("Date must be YYYY-MM-DD");
const slotParam = param("slot").isIn(SLOT_KEYS);

// ------------------------------------------------------------------ customer
const customer = Router();
customer.use(authFor(["/subscription-plans", "/subscriptions"], authMiddleware));

customer.get("/subscription-plans", query("kitchenId").optional({ values: "falsy" }).isMongoId(), validate, asyncHandler(async (req, res) => {
  const { kitchen } = await resolveCustomerKitchen({ kitchenId: req.query.kitchenId || null, userId: req.auth.userId });
  return ok(res, await plans.plansForKitchen(kitchen._id), "Plans fetched.");
}));
customer.get("/subscription-plans/:code", param("code").isString().isLength({ max: 30 }), validate, asyncHandler(async (req, res) => {
  const { SubscriptionPlan } = await import("./subscription.model.js");
  const plan = await SubscriptionPlan.findOne({ code: req.params.code.toUpperCase(), status: "active" }).lean();
  if (!plan) throw new AppError(404, "Plan not found");
  return ok(res, plans.toPlan(plan), "Plan fetched.");
}));
customer.post(
  "/subscriptions/checkout",
  body("planCode").isString().isLength({ min: 2, max: 30 }),
  body("billingMethod").isIn(["autopay", "link"]),
  body("addressId").isMongoId(),
  body("startDate").optional({ values: "null" }).isISO8601({ strict: true }),
  validate,
  idempotent(),
  asyncHandler(async (req, res) => ok(res, await subs.checkout(req.auth.userId, req.body), "Subscription created. Complete the payment to start.", 201)),
);
// Same as POST /payments/verify, kept on the subscription path for the app.
customer.post("/subscriptions/:id/verify-payment", idParam(), body("gatewayOrderId").isString(), body("gatewayPaymentId").isString(), body("signature").isString(), validate, asyncHandler(async (req, res) => {
  const { verifyFromApp } = await import("../payment/payment.service.js");
  const result = await verifyFromApp(req.auth.userId, req.body);
  if (result.refId !== req.params.id) throw new AppError(409, "Payment belongs to another subscription");
  return ok(res, (await subs.mySubscription(req.auth.userId)).subscription, "Subscription active.");
}));
customer.get("/subscriptions/me", asyncHandler(async (req, res) => ok(res, await subs.mySubscription(req.auth.userId), "Subscription fetched.")));
customer.get("/subscriptions/me/week", asyncHandler(async (req, res) => ok(res, await meals.weekView(req.auth.userId), "Upcoming meals.")));
customer.get("/subscriptions/me/days/:date", dateParam, validate, asyncHandler(async (req, res) => ok(res, await meals.dayView(req.auth.userId, req.params.date), "Day fetched.")));
customer.get("/subscriptions/me/menu", query("date").isISO8601({ strict: true }), query("slot").isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => ok(res, await meals.slotMenu(req.auth.userId, req.query), "Menu fetched.")));
customer.get("/subscriptions/me/days/:date/slots/:slot", dateParam, slotParam, validate, asyncHandler(async (req, res) => ok(res, await meals.getSelection(req.auth.userId, req.params), "Meal fetched.")));
customer.get("/subscriptions/me/days/:date/slots/:slot/selection", dateParam, slotParam, validate, asyncHandler(async (req, res) => ok(res, await meals.getSelection(req.auth.userId, req.params), "Meal fetched.")));
customer.put(
  "/subscriptions/me/days/:date/slots/:slot/selection",
  dateParam,
  slotParam,
  body("items").isArray({ min: 1, max: 20 }),
  body("items.*.dishId").isMongoId(),
  body("items.*.qty").optional().isInt({ min: 1, max: 10 }).toInt(),
  validate,
  asyncHandler(async (req, res) => ok(res, await meals.saveSelection(req.auth.userId, { ...req.params, items: req.body.items }), "Meal saved.")),
);
customer.get("/subscriptions/me/shift-preview", query("date").isISO8601({ strict: true }), query("slot").optional().isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => ok(res, await meals.shiftPreview(req.auth.userId, req.query), "Shift preview.")));
customer.post("/subscriptions/me/shift", body("date").isISO8601({ strict: true }), body("slot").optional({ values: "null" }).isIn(SLOT_KEYS), validate, idempotent(), asyncHandler(async (req, res) => ok(res, await meals.shift(req.auth.userId, req.body), "Meal shifted.")));
customer.get("/subscriptions/me/change-plan/preview", query("planCode").isString(), validate, asyncHandler(async (req, res) => ok(res, await subs.changePlanPreview(req.auth.userId, req.query.planCode), "Plan change preview.")));
customer.post("/subscriptions/me/change-plan", body("planCode").isString(), validate, asyncHandler(async (req, res) => ok(res, await subs.changePlan(req.auth.userId, req.body.planCode), "Plan change scheduled.")));
customer.get("/subscriptions/me/pause-options", asyncHandler(async (req, res) => ok(res, await subs.pauseOptions(req.auth.userId), "Pause options.")));
customer.post("/subscriptions/me/pause", body("months").isInt({ min: 1, max: 12 }).toInt(), validate, asyncHandler(async (req, res) => ok(res, await subs.pause(req.auth.userId, req.body), "Pause scheduled.")));
customer.post("/subscriptions/me/resume", asyncHandler(async (req, res) => ok(res, await subs.resume(req.auth.userId), "Subscription resumed.")));
customer.get("/subscriptions/me/cancel-reasons", asyncHandler(async (req, res) => ok(res, await subs.cancelReasons(), "Reasons.")));
customer.post("/subscriptions/me/cancel", body("reasonId").isString().isLength({ max: 10 }), body("comment").optional().isString().isLength({ max: 500 }), validate, asyncHandler(async (req, res) => ok(res, await subs.cancel(req.auth.userId, req.body), "Cancellation scheduled.")));
customer.post("/subscriptions/me/cancel/undo", asyncHandler(async (req, res) => ok(res, await subs.undoCancel(req.auth.userId), "Cancellation undone.")));
customer.patch("/subscriptions/me/address", body("addressId").isMongoId(), validate, asyncHandler(async (req, res) => ok(res, await subs.updateAddress(req.auth.userId, req.body.addressId), "Address updated.")));
customer.patch("/subscriptions/me/payment-method", body("billingMethod").isIn(["autopay", "link"]), validate, asyncHandler(async (req, res) => ok(res, await subs.switchBillingMethod(req.auth.userId, req.body.billingMethod), "Billing method updated.")));
customer.get("/subscriptions/me/invoices", asyncHandler(async (req, res) => ok(res, await subs.myInvoices(req.auth.userId), "Invoices fetched.")));
customer.get("/subscriptions/me/invoices/:id/pdf", idParam(), validate, asyncHandler(async (req, res) => {
  const { Invoice } = await import("../billing/billing.model.js");
  const { invoicePdf } = await import("../billing/billing.service.js");
  const invoice = await Invoice.findOne({ _id: req.params.id, user: req.auth.userId }).lean();
  if (!invoice) throw new AppError(404, "Invoice not found");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber.replace(/\//g, "-")}.pdf"`);
  return res.send(invoicePdf(invoice));
}));

// ------------------------------------------------------------------ kitchen
const kitchen = Router();
kitchen.use(authFor(["/slots", "/slot-menus", "/meal-plan", "/meals"], authMiddleware));
kitchen.get("/slots", authorize("kitchen.desk"), ownKitchen, asyncHandler(async (req, res) => ok(res, await slots.listSlots(req.kitchenId), "Slots fetched.")));
kitchen.put("/slots/:key", authorize("kitchen.slots"), ownKitchen, param("key").isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => {
  const data = await slots.saveSlot(req.kitchenId, req.params.key, req.body);
  await recordAudit(req, { action: "meal_slot.saved", entityType: "meal_slot", entityId: data.slotId, kitchenId: req.kitchenId, summary: `${data.name}: ${data.windowStart}–${data.windowEnd}, cutoff ${data.cutoffDay === "previous_day" ? "previous day " : ""}${data.cutoffTime}`, after: data, diff: false });
  return ok(res, data, "Slot saved.");
}));
kitchen.get("/slot-menus", authorize("kitchen.desk"), ownKitchen, query("from").optional().isISO8601(), query("to").optional().isISO8601(), validate, asyncHandler(async (req, res) => ok(res, await slots.listSlotMenus(req.kitchenId, req.query), "Slot menus fetched.")));
kitchen.put("/slot-menus", authorize("kitchen.slots"), ownKitchen, body("slot").isIn(SLOT_KEYS), body("dishIds").isArray({ max: 60 }), body("defaultDishIds").optional().isArray(), validate, asyncHandler(async (req, res) => {
  const data = await slots.saveSlotMenu(req.kitchenId, req.body);
  await recordAudit(req, { action: "slot_menu.saved", entityType: "slot_menu", entityId: data.menuId, kitchenId: req.kitchenId, summary: `${data.slot} menu for ${data.date || `weekday ${data.weekday}`} (${data.dishIds.length} dishes)`, diff: false });
  return ok(res, data, "Menu saved.");
}));
kitchen.delete("/slot-menus/:id", authorize("kitchen.slots"), ownKitchen, idParam(), validate, asyncHandler(async (req, res) => ok(res, await slots.deleteSlotMenu(req.kitchenId, req.params.id), "Menu deleted.")));
kitchen.get("/meal-plan", authorize("kitchen.production"), ownKitchen, query("date").optional().isISO8601({ strict: true }), query("slot").optional().isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => (
  ok(res, await slots.productionSheet(req.kitchenId, { date: req.query.date || istDateKey(), slot: req.query.slot || null }), "Production sheet.")
)));
kitchen.get("/meal-plan/pdf", authorize("kitchen.production"), ownKitchen, query("date").optional().isISO8601({ strict: true }), query("slot").optional().isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => {
  const sheet = await slots.productionSheet(req.kitchenId, { date: req.query.date || istDateKey(), slot: req.query.slot || null });
  const record = await Kitchen.findById(req.kitchenId).select("name").lean();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="production-${sheet.date}.pdf"`);
  return res.send(slots.productionPdf(sheet, record?.name || "Kitchen"));
}));
kitchen.post("/meals/:id/:action", authorize("kitchen.delivery"), ownKitchen, idParam(), param("action").isIn(["dispatch", "deliver"]), validate, asyncHandler(async (req, res) => ok(res, await meals.kitchenMealAction(req.kitchenId, req.params.id, req.params.action), "Meal updated.")));
kitchen.post("/meal-plan/dispatch", authorize("kitchen.delivery"), ownKitchen, body("date").isISO8601({ strict: true }), body("slot").isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => ok(res, await meals.kitchenBulkDispatch(req.kitchenId, req.body), "Meals dispatched.")));

// ------------------------------------------------------------------ admin
const admin = Router();
admin.use(authFor(["/subscription-plans", "/subscriptions", "/meal-slots", "/meal-plan"], authMiddleware));
admin.get("/subscription-plans", authorize("subscriptions.read"), query("status").optional().isIn(["draft", "active", "retired"]), validate, asyncHandler(async (req, res) => ok(res, await plans.listPlans(req.query), "Plans fetched.")));
admin.get("/subscription-plans/:id", authorize("subscriptions.read"), idParam(), validate, asyncHandler(async (req, res) => ok(res, plans.toPlan(await plans.getPlan(req.params.id), { admin: true }), "Plan fetched.")));
admin.post("/subscription-plans", authorize("plans.manage"), asyncHandler(async (req, res) => {
  const data = await plans.savePlan(null, req.body);
  await recordAudit(req, { action: "plan.created", entityType: "plan", entityId: data.planId, summary: `Created plan ${data.name} (${data.planCode})`, after: { pricePaise: data.pricePaise, cycleDays: data.cycleDays, slots: data.slots }, diff: false });
  return ok(res, data, "Plan created.", 201);
}));
admin.patch("/subscription-plans/:id", authorize("plans.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const { before, after } = await plans.savePlan(req.params.id, req.body);
  await recordAudit(req, { action: "plan.updated", entityType: "plan", entityId: after.planId, summary: `Updated plan ${after.name}`, before, after, reason: req.body.reason || null });
  return ok(res, after, "Plan updated. Existing subscribers keep their terms.");
}));
admin.post("/subscription-plans/:id/duplicate", authorize("plans.manage"), idParam(), body("code").optional().matches(/^[A-Za-z0-9_]{2,30}$/), body("name").optional().isString().isLength({ max: 60 }), validate, asyncHandler(async (req, res) => {
  const data = await plans.duplicatePlan(req.params.id, req.body);
  await recordAudit(req, { action: "plan.duplicated", entityType: "plan", entityId: data.planId, summary: `Copied a plan into draft ${data.planCode}`, diff: false });
  return ok(res, data, "Plan copied as a draft.", 201);
}));
admin.post("/subscription-plans/:id/status", authorize("plans.manage"), idParam(), body("status").isIn(["draft", "active", "retired"]), validate, asyncHandler(async (req, res) => {
  const data = await plans.setPlanStatus(req.params.id, req.body.status);
  await recordAudit(req, { action: `plan.${req.body.status}`, entityType: "plan", entityId: data.planId, summary: `Plan ${data.name} is now ${data.status}`, diff: false });
  return ok(res, data, "Plan status changed.");
}));

admin.get("/subscriptions", authorize("subscriptions.read"), pageQuery, query("status").optional().isString(), query("kitchenId").optional({ values: "falsy" }).isMongoId(), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await subs.listSubscriptions({ ...req.query, page, limit }), "Subscriptions fetched.");
}));
admin.get("/subscriptions/cancel-reasons", authorize("subscriptions.read"), asyncHandler(async (req, res) => ok(res, await subs.cancelReasons(), "Reasons.")));
admin.get("/subscriptions/:id/pause-options", authorize("subscriptions.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await subs.pauseOptionsFor(req.params.id), "Pause options.")));
admin.get("/subscriptions/:id", authorize("subscriptions.read"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await subs.getSubscriptionAdmin(req.params.id), "Subscription fetched.")));
admin.get("/subscriptions/:id/meals", authorize("subscriptions.read"), idParam(), validate, asyncHandler(async (req, res) => {
  const { MealSelection } = await import("./subscription.model.js");
  const items = await MealSelection.find({ subscription: req.params.id }).sort({ date: -1 }).limit(120).lean();
  return ok(res, items.map((meal) => ({ mealId: String(meal._id), date: meal.date, slot: meal.slot, status: meal.status, source: meal.source, items: meal.items, shiftedTo: meal.shiftedTo, shiftedFrom: meal.shiftedFrom })), "Meals fetched.");
}));
admin.post(
  "/subscriptions/:id/actions",
  authorize("subscriptions.manage"),
  idParam(),
  body("action").isIn(["pause", "resume", "cancel", "switch_billing", "resend_link", "extend", "reactivate"]),
  body("reason").optional().isString().isLength({ max: 300 }),
  validate,
  asyncHandler(async (req, res) => {
    const data = await subs.adminAction(req.params.id, req.body, req.auth.user?.name);
    await recordAudit(req, { action: `subscription.${req.body.action}`, entityType: "subscription", entityId: req.params.id, kitchenId: data.kitchenId, summary: `${req.body.action.replace("_", " ")} on behalf of the customer`, reason: req.body.reason || req.body.comment || null, after: { status: data.status, validTill: data.validTill }, diff: false });
    return ok(res, data, "Subscription updated.");
  }),
);

// Platform view of any kitchen's slots, menus and production.
admin.get("/meal-slots", authorize("subscriptions.read"), query("kitchenId").isMongoId(), validate, asyncHandler(async (req, res) => ok(res, await slots.listSlots(req.query.kitchenId), "Slots fetched.")));
admin.put("/meal-slots/:kitchenId/:key", authorize("plans.manage"), param("kitchenId").isMongoId(), param("key").isIn(SLOT_KEYS), validate, asyncHandler(async (req, res) => {
  const data = await slots.saveSlot(req.params.kitchenId, req.params.key, req.body);
  await recordAudit(req, { action: "meal_slot.saved", entityType: "meal_slot", entityId: data.slotId, kitchenId: req.params.kitchenId, summary: `${data.name} slot saved by MealJi`, after: data, diff: false });
  return ok(res, data, "Slot saved.");
}));
const adminSheetQuery = [query("kitchenId").isMongoId(), query("date").optional().isISO8601({ strict: true }), query("slot").optional({ values: "falsy" }).isIn(SLOT_KEYS)];
admin.get("/meal-plan", (req, res, next) => (has(req, "subscriptions.read") ? next() : next(new AppError(403, "You do not have permission to perform this action"))), adminSheetQuery, validate, asyncHandler(async (req, res) => (
  ok(res, await slots.productionSheet(req.query.kitchenId, { date: req.query.date || istDateKey(), slot: req.query.slot || null }), "Production sheet.")
)));
admin.get("/meal-plan/pdf", authorize("subscriptions.read"), adminSheetQuery, validate, asyncHandler(async (req, res) => {
  const sheet = await slots.productionSheet(req.query.kitchenId, { date: req.query.date || istDateKey(), slot: req.query.slot || null });
  const record = await Kitchen.findById(req.query.kitchenId).select("name").lean();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="production-${sheet.date}.pdf"`);
  return res.send(slots.productionPdf(sheet, record?.name || "Kitchen"));
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, customer);
  app.use("/api/v1/kitchen", recordMountPath, kitchen);
  app.use("/api/v1/admin", recordMountPath, admin);
}
