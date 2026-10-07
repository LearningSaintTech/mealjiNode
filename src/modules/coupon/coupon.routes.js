import { Router } from "express";
import { param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok, ownKitchen, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import * as coupons from "./coupon.service.js";

// Platform coupons (coupons.manage) and kitchen-funded offers (kitchen admins,
// when the menu policy allows; they wait for platform approval).
const admin = Router();
admin.use(authFor(["/coupons"], authMiddleware));
admin.get("/coupons", authorize("coupons.manage"), pageQuery, query("status").optional().isIn(["active", "inactive", "pending"]), query("kitchenId").optional({ values: "falsy" }).isMongoId(), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await coupons.listCoupons({ ...req.query, page, limit }), "Coupons fetched.");
}));
admin.post("/coupons", authorize("coupons.manage"), asyncHandler(async (req, res) => {
  const data = await coupons.saveCoupon(null, req.body, { actorId: req.auth.userId });
  await recordAudit(req, { action: "coupon.created", entityType: "coupon", entityId: data.couponId, summary: `Created coupon ${data.code} (${data.label})`, after: data, diff: false });
  return ok(res, data, "Coupon created.", 201);
}));
admin.patch("/coupons/:id", authorize("coupons.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const data = await coupons.saveCoupon(req.params.id, req.body);
  await recordAudit(req, { action: "coupon.updated", entityType: "coupon", entityId: data.couponId, summary: `Updated coupon ${data.code}`, after: req.body, diff: false });
  return ok(res, data, "Coupon updated.");
}));
admin.post("/coupons/:id/:decision", authorize("coupons.manage"), idParam(), param("decision").isIn(["approve", "reject"]), validate, asyncHandler(async (req, res) => {
  const data = await coupons.reviewCoupon(req.params.id, req.params.decision === "approve");
  await recordAudit(req, { action: `coupon.${req.params.decision === "approve" ? "approved" : "rejected"}`, entityType: "coupon", entityId: data.couponId, kitchenId: data.kitchenId, summary: `${req.params.decision === "approve" ? "Approved" : "Rejected"} kitchen offer ${data.code}`, diff: false });
  return ok(res, data, "Offer reviewed.");
}));
admin.delete("/coupons/:id", authorize("coupons.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const data = await coupons.deleteCoupon(req.params.id);
  await recordAudit(req, { action: "coupon.deleted", entityType: "coupon", entityId: req.params.id, summary: `Deleted coupon ${data.code}`, diff: false });
  return ok(res, data, "Coupon deleted.");
}));
admin.get("/coupons/:id/stats", authorize("coupons.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await coupons.couponStats(req.params.id), "Coupon stats.")));

const kitchen = Router();
kitchen.use(authFor(["/offers"], authMiddleware));
async function offersAllowed(req, res, next) {
  try {
    const policy = (await resolveSetting("menu_policy", { kitchenId: req.kitchenId })).values;
    if (!policy.kitchenFundedOffers) throw new AppError(403, "Kitchen offers are not enabled for this kitchen");
    next();
  } catch (err) {
    next(err);
  }
}
kitchen.get("/offers", authorize("kitchen.menu"), ownKitchen, offersAllowed, asyncHandler(async (req, res) => ok(res, await coupons.listCoupons({ kitchenId: req.kitchenId, page: 1, limit: 100 }), "Offers fetched.")));
kitchen.post("/offers", authorize("kitchen.menu"), ownKitchen, offersAllowed, asyncHandler(async (req, res) => {
  const data = await coupons.saveCoupon(null, req.body, { kitchenId: req.kitchenId, actorId: req.auth.userId, requireApproval: true });
  await recordAudit(req, { action: "coupon.requested", entityType: "coupon", entityId: data.couponId, kitchenId: req.kitchenId, summary: `Kitchen offer ${data.code} sent for approval`, diff: false });
  return ok(res, data, "Offer sent to MealJi for approval.", 201);
}));
kitchen.patch("/offers/:id", authorize("kitchen.menu"), ownKitchen, offersAllowed, idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, await coupons.saveCoupon(req.params.id, req.body, { kitchenId: req.kitchenId, requireApproval: true }), "Offer updated. It goes live again once MealJi approves it.")
)));

export function mount(app, recordMountPath) {
  app.use("/api/v1/admin", recordMountPath, admin);
  app.use("/api/v1/kitchen", recordMountPath, kitchen);
}
