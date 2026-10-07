import mongoose from "mongoose";
import { Router } from "express";
import { body } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { fetchPayment, gatewayName } from "../../infrastructure/payments/gateway.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { Payment } from "./payment.model.js";

// Saved payment methods hold gateway token references only (RBI card-on-file
// tokenisation): never card numbers. They are created from a successful
// checkout where the customer chose to save the method.
const savedMethodSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["card", "upi"], required: true },
    gateway: { type: String, required: true },
    gatewayTokenId: { type: String, required: true },
    gatewayCustomerId: { type: String, default: null },
    network: { type: String, default: null },
    issuer: { type: String, default: null },
    last4: { type: String, default: null },
    expMonth: { type: Number, default: null },
    expYear: { type: Number, default: null },
    vpaMasked: { type: String, default: null },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);
savedMethodSchema.index({ user: 1, gatewayTokenId: 1 }, { unique: true });
export const SavedPaymentMethod = mongoose.model("SavedPaymentMethod", savedMethodSchema);

const toMethod = (row) => ({
  paymentMethodId: String(row._id),
  type: row.type,
  label: row.type === "card" ? `${row.network || "Card"} •••• ${row.last4}` : row.vpaMasked,
  network: row.network,
  issuer: row.issuer,
  last4: row.last4,
  expMonth: row.expMonth,
  expYear: row.expYear,
  vpaMasked: row.vpaMasked,
  isDefault: row.isDefault,
  expired: row.expYear ? new Date(row.expYear, row.expMonth || 12, 0) < new Date() : false,
  gatewayTokenId: row.gatewayTokenId,
});

function maskVpa(vpa) {
  const [name, host] = String(vpa || "").split("@");
  return name ? `${name.slice(0, 2)}${"•".repeat(Math.max(2, name.length - 2))}@${host || ""}` : null;
}

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
  body("makeDefault").optional().isBoolean(),
  validate,
  asyncHandler(async (req, res) => {
    const payment = await Payment.findOne({ _id: req.body.paymentId, user: req.auth.userId, status: { $in: ["captured", "refunded", "partially_refunded"] } }).lean();
    if (!payment?.gatewayPaymentId) throw new AppError(404, "Payment not found");
    let details;
    if (gatewayName() === "razorpay") {
      const remote = await fetchPayment(payment.gatewayPaymentId);
      if (!remote.token_id) throw new AppError(409, "This payment was not saved for future use");
      details = remote.method === "card"
        ? { type: "card", gatewayTokenId: remote.token_id, gatewayCustomerId: remote.customer_id || null, network: remote.card?.network, issuer: remote.card?.issuer, last4: remote.card?.last4, expMonth: Number(remote.card?.expiry_month) || null, expYear: Number(remote.card?.expiry_year) || null }
        : { type: "upi", gatewayTokenId: remote.token_id, gatewayCustomerId: remote.customer_id || null, vpaMasked: maskVpa(remote.vpa) };
    } else {
      const type = req.body.type === "upi" ? "upi" : "card";
      details = type === "card"
        ? { type, gatewayTokenId: `token_test_${payment.gatewayPaymentId}`, network: req.body.network || "Visa", last4: String(req.body.last4 || "4242").slice(-4), expMonth: req.body.expMonth || 12, expYear: req.body.expYear || new Date().getFullYear() + 3 }
        : { type, gatewayTokenId: `token_test_${payment.gatewayPaymentId}`, vpaMasked: maskVpa(req.body.vpa || "user@upi") };
    }
    const count = await SavedPaymentMethod.countDocuments({ user: req.auth.userId });
    if (count >= 10) throw new AppError(409, "You can save up to 10 methods");
    const makeDefault = req.body.makeDefault === true || count === 0;
    if (makeDefault) await SavedPaymentMethod.updateMany({ user: req.auth.userId }, { $set: { isDefault: false } });
    const row = await SavedPaymentMethod.findOneAndUpdate(
      { user: req.auth.userId, gatewayTokenId: details.gatewayTokenId },
      { $set: { ...details, gateway: gatewayName(), isDefault: makeDefault } },
      { upsert: true, new: true },
    );
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
router.get("/wallet", asyncHandler(async (req, res) => {
  const [user, loyalty, app] = await Promise.all([User.findById(req.auth.userId).select("pointsBalance tier").lean(), resolveSetting("loyalty"), resolveSetting("app")]);
  return ok(res, {
    points: user?.pointsBalance || 0,
    pointsValuePaise: (user?.pointsBalance || 0) * loyalty.values.pointValuePaise,
    tier: user?.tier || null,
    moneyWallet: app.values.featureWallet ? { balancePaise: 0, enabled: true } : null,
  }, "Wallet.");
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, router);
}
