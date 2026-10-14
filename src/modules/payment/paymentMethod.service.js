import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { logger } from "../../config/logger.js";
import { createGatewayCustomer, fetchPayment, gatewayName } from "../../infrastructure/payments/gateway.js";
import { User } from "../user/user.model.js";

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
    upiApp: { type: String, default: null }, // "Google Pay", "PhonePe", "Paytm" … from the UPI handle
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);
savedMethodSchema.index({ user: 1, gatewayTokenId: 1 }, { unique: true });
export const SavedPaymentMethod = mongoose.models.SavedPaymentMethod || mongoose.model("SavedPaymentMethod", savedMethodSchema);

// UPI handle → the app people know (for “Google Pay · UPI linked to …”).
const UPI_APPS = [
  [/^(okhdfcbank|okicici|oksbi|okaxis)$/, "Google Pay"],
  [/^(ybl|ibl|axl)$/, "PhonePe"],
  [/^(paytm|ptyes|ptaxis|pthdfc|ptsbi)$/, "Paytm"],
  [/^(apl|yapl|rapl)$/, "Amazon Pay"],
  [/^(upi)$/, "BHIM"],
];
export function upiAppFor(vpa) {
  const handle = String(vpa || "").split("@")[1]?.toLowerCase() || "";
  return UPI_APPS.find(([pattern]) => pattern.test(handle))?.[1] || "UPI";
}

export function maskVpa(vpa) {
  const [name, host] = String(vpa || "").split("@");
  return name ? `${name.slice(0, 2)}${"•".repeat(Math.max(2, name.length - 2))}@${host || ""}` : null;
}

const pad = (n) => String(n).padStart(2, "0");

/** One row of the Payment methods screen. The gateway token stays on the server. */
export function toMethod(row) {
  const card = row.type === "card";
  return {
    paymentMethodId: String(row._id),
    type: row.type,
    label: card ? `${row.network || "Card"} •••• ${row.last4}` : row.vpaMasked,
    // Screen rows: “Visa •••• 4242 / Expires 12/26”, “Google Pay / UPI linked to pr••••@okhdfcbank”.
    title: card ? `${row.network || "Card"} •••• ${row.last4}` : row.upiApp || "UPI",
    subtitle: card ? (row.expMonth && row.expYear ? `Expires ${pad(row.expMonth)}/${String(row.expYear).slice(-2)}` : null) : `UPI linked to ${row.vpaMasked}`,
    upiApp: card ? null : row.upiApp || "UPI",
    network: row.network,
    issuer: row.issuer,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    vpaMasked: row.vpaMasked,
    isDefault: row.isDefault,
    expired: row.expYear ? new Date(row.expYear, row.expMonth || 12, 0) < new Date() : false,
  };
}

/**
 * The customer's gateway customer id, created once (Razorpay keeps saved
 * cards / UPI under it). Null when the gateway cannot be reached: paying still
 * works, only “save this method” is not offered.
 */
export async function ensureGatewayCustomer(signedIn) {
  if (!signedIn?._id) return null;
  // The signed-in user may be loaded without this field: read it once.
  const user = signedIn.gatewayCustomer !== undefined ? signedIn : await User.findById(signedIn._id).select("gatewayCustomer name email phoneNumber").lean();
  if (!user) return null;
  const gateway = gatewayName();
  if (user.gatewayCustomer?.id && user.gatewayCustomer.gateway === gateway) return user.gatewayCustomer.id;
  try {
    const id = await createGatewayCustomer({ name: user.name, email: user.email, contact: user.phoneNumber ? `+91${user.phoneNumber}` : null });
    await User.updateOne({ _id: user._id }, { $set: { gatewayCustomer: { id, gateway } } });
    return id;
  } catch (err) {
    logger.warn({ err: err.message, userId: String(user._id) }, "Gateway customer could not be created");
    return null;
  }
}

/** Saves the method used for a captured payment (route S09.7, or automatically after paying with “Save”). */
export async function saveMethodFromPayment(userId, payment, input = {}) {
  let details;
  if (gatewayName() === "razorpay") {
    const remote = await fetchPayment(payment.gatewayPaymentId);
    if (!remote.token_id) throw new AppError(409, "This payment was not saved for future use");
    details = remote.method === "card"
      ? { type: "card", gatewayTokenId: remote.token_id, gatewayCustomerId: remote.customer_id || null, network: remote.card?.network, issuer: remote.card?.issuer, last4: remote.card?.last4, expMonth: Number(remote.card?.expiry_month) || null, expYear: Number(remote.card?.expiry_year) || null }
      : { type: "upi", gatewayTokenId: remote.token_id, gatewayCustomerId: remote.customer_id || null, vpaMasked: maskVpa(remote.vpa), upiApp: upiAppFor(remote.vpa) };
  } else {
    const type = input.type === "upi" || (!input.type && payment.method === "upi") ? "upi" : "card";
    details = type === "card"
      ? { type, gatewayTokenId: `token_test_${payment.gatewayPaymentId}`, network: input.network || "Visa", last4: String(input.last4 || "4242").slice(-4), expMonth: input.expMonth || 12, expYear: input.expYear || new Date().getFullYear() + 3 }
      : { type, gatewayTokenId: `token_test_${payment.gatewayPaymentId}`, vpaMasked: maskVpa(input.vpa || "user@okhdfcbank"), upiApp: upiAppFor(input.vpa || "user@okhdfcbank") };
  }
  const count = await SavedPaymentMethod.countDocuments({ user: userId });
  if (count >= 10) throw new AppError(409, "You can save up to 10 methods");
  const makeDefault = input.makeDefault === true || count === 0;
  if (makeDefault) await SavedPaymentMethod.updateMany({ user: userId }, { $set: { isDefault: false } });
  return SavedPaymentMethod.findOneAndUpdate(
    { user: userId, gatewayTokenId: details.gatewayTokenId },
    { $set: { ...details, gateway: gatewayName(), isDefault: makeDefault } },
    { upsert: true, new: true },
  );
}
