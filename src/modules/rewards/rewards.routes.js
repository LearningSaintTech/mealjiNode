import { Router } from "express";
import { body, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, idParam, ok, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { RewardTransaction } from "./ledger.model.js";
import * as rewards from "./rewards.service.js";
import "./reports.loyalty.js";

const customer = Router();
customer.use(authFor(["/rewards", "/referrals"], authMiddleware));
customer.get("/rewards/summary", asyncHandler(async (req, res) => ok(res, await rewards.summary(req.auth.userId), "Rewards summary.")));
customer.get("/rewards/catalog", asyncHandler(async (req, res) => ok(res, await rewards.catalog(req.auth.userId), "Reward catalogue.")));
customer.get("/rewards/earn-methods", asyncHandler(async (req, res) => ok(res, await rewards.earnMethods(), "Ways to earn.")));
customer.get("/rewards/history", pageQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await rewards.history(req.auth.userId, { page, limit }), "Points history.");
}));
customer.get("/rewards/redemptions", asyncHandler(async (req, res) => ok(res, await rewards.myRedemptions(req.auth.userId), "Your rewards.")));
customer.post("/rewards/:id/redeem", idParam(), validate, asyncHandler(async (req, res) => ok(res, await rewards.redeem(req.auth.userId, req.params.id), "Reward redeemed. Use the code at checkout.", 201)));
customer.get("/referrals/me", asyncHandler(async (req, res) => ok(res, await rewards.myReferrals(req.auth.userId), "Referrals.")));
customer.post("/referrals/apply", body("code").isString().trim().isLength({ min: 4, max: 20 }), validate, asyncHandler(async (req, res) => ok(res, await rewards.applyReferralCode(req.auth.userId, req.body.code), "Referral code applied.")));

const admin = Router();
admin.use(authFor(["/rewards", "/referrals", "/users"], authMiddleware));
admin.get("/rewards", authorize("rewards.manage"), asyncHandler(async (req, res) => ok(res, await rewards.listRewardsAdmin(), "Rewards fetched.")));
admin.post("/rewards", authorize("rewards.manage"), asyncHandler(async (req, res) => {
  const data = await rewards.saveReward(null, req.body);
  await recordAudit(req, { action: "reward.created", entityType: "reward", entityId: data.rewardId, summary: `Added reward ${data.name} (${data.points} pts)`, diff: false });
  return ok(res, data, "Reward added.", 201);
}));
admin.patch("/rewards/:id", authorize("rewards.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const data = await rewards.saveReward(req.params.id, req.body);
  await recordAudit(req, { action: "reward.updated", entityType: "reward", entityId: data.rewardId, summary: `Updated reward ${data.name}`, after: req.body, diff: false });
  return ok(res, data, "Reward updated.");
}));
admin.get("/rewards/tiers", authorize("rewards.manage"), asyncHandler(async (req, res) => {
  const { resolveSetting } = await import("../settings/settings.service.js");
  const loyalty = (await resolveSetting("loyalty")).values;
  return ok(res, loyalty.tierNames.map((name, index) => ({ name, threshold: loyalty.tierThresholds[index] ?? null })), "Tiers.");
}));
admin.get("/rewards/liability", authorize("rewards.manage"), asyncHandler(async (req, res) => ok(res, await rewards.liability(), "Liability.")));
admin.post(
  "/rewards/adjust",
  authorize("rewards.manage"),
  body("userId").isMongoId(),
  body("points").isInt({ min: -100000, max: 100000 }).toInt(),
  body("reason").isString().trim().isLength({ min: 3, max: 200 }),
  validate,
  asyncHandler(async (req, res) => {
    const data = await rewards.adjustPoints({ ...req.body, actor: { userId: req.auth.userId, name: req.auth.user?.name } });
    await recordAudit(req, { action: "points.adjusted", entityType: "user", entityId: req.body.userId, summary: `${req.body.points > 0 ? "Added" : "Removed"} ${Math.abs(req.body.points)} points`, reason: req.body.reason, diff: false });
    return ok(res, data, "Points adjusted.");
  }),
);
admin.get("/users/:id/points", authorize("users.read"), idParam(), pageQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const [items, total, summary] = await Promise.all([
    RewardTransaction.find({ user: req.params.id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    RewardTransaction.countDocuments({ user: req.params.id }),
    rewards.summary(req.params.id),
  ]);
  return ok(res, { summary, items: items.map((row) => ({ points: row.points, type: row.type, source: row.source, title: row.title, reason: row.reason, actor: row.actor, createdAt: row.createdAt })), page, limit, total }, "Points ledger.");
}));
admin.get("/referrals", (req, res, next) => authorize("referrals.read")(req, res, next), pageQuery, query("status").optional().isIn(["pending", "converted", "rejected"]), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await rewards.listReferrals({ ...req.query, page, limit }), "Referrals.");
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, customer);
  app.use("/api/v1/admin", recordMountPath, admin);
}
