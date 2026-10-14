import { Router } from "express";
import { body } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { saveMethodFromPayment, SavedPaymentMethod, toMethod } from "./paymentMethod.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Payment } from "./payment.model.js";

const router = Router();
router.use(authFor(["/payment-methods", "/wallet"], authMiddleware));

router.get("/payment-methods", asyncHandler(async (req, res) => {
  const rows = await SavedPaymentMethod.find({ user: req.auth.userId }).sort({ isDefault: -1, updatedAt: -1 }).lean();
  return ok(res, rows.map(toMethod), "Saved methods.");
}));

/**
 * Saves the method used for a captured payment. With Razorpay the token comes
 * from the payment (saved via checkout with `save: 1`); in the test gateway the
 * app sends the display details.
 */
router.post(
  "/payment-methods",
  body("paymentId").isMongoId().withMessage("paymentId of a successful payment is required"),
  body("makeDefault").optional().isBoolean().toBoolean(true),
  validate,
  asyncHandler(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.body.paymentId, user: req.auth.userId, status: { $in: ["captured", "refunded", "partially_refunded"] } }).lean();
    if (!payment?.gatewayPaymentId) throw new AppError(404, "Payment not found");
    const row = await saveMethodFromPayment(req.auth.userId, payment, req.body);
    return ok(res, toMethod(row), "Payment method saved.", 201);
  }),
);
router.patch("/payment-methods/:id/default", idParam(), validate, asyncHandler(async (req, res) => {
  const row = await SavedPaymentMethod.findOne({ _id: req.params.id, user: req.auth.userId });
  if (!row) throw new AppError(404, "Payment method not found");
  await SavedPaymentMethod.updateMany({ user: req.auth.userId }, { $set: { isDefault: false } });
  row.isDefault = true;
  await row.save();
  return ok(res, toMethod(row), "Default updated.");
}));
router.delete("/payment-methods/:id", idParam(), validate, asyncHandler(async (req, res) => {
  const row = await SavedPaymentMethod.findOneAndDelete({ _id: req.params.id, user: req.auth.userId });
  if (!row) throw new AppError(404, "Payment method not found");
  if (row.isDefault) {
    const next = await SavedPaymentMethod.findOne({ user: req.auth.userId }).sort({ updatedAt: -1 });
    if (next) await SavedPaymentMethod.updateOne({ _id: next._id }, { $set: { isDefault: true } });
  }
  return ok(res, { deleted: true }, "Payment method removed.");
}));

// Points act as the wallet (no money wallet in v1, per the decisions log).
// Payment methods · “Meal ji wallet” card: points, “Updated 2m ago”, “enough points for 3 free rewards!”.
router.get("/wallet", asyncHandler(async (req, res) => {
  const { pointsCard } = await import("../rewards/rewards.service.js");
  const [card, loyalty, app] = await Promise.all([pointsCard(req.auth.userId), resolveSetting("loyalty"), resolveSetting("app")]);
  return ok(res, {
    points: card.points,
    pointsValuePaise: card.points * loyalty.values.pointValuePaise,
    tier: card.tier,
    updatedLabel: card.updatedLabel,
    rewardsMessage: card.message,
    affordableCount: card.affordableCount,
    moneyWallet: app.values.featureWallet ? { balancePaise: 0, enabled: true } : null,
  }, "Wallet.");
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, router);
}
