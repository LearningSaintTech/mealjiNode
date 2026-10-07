import mongoose from "mongoose";

// Record of consent (DPDP Act): every change of a channel × purpose permission,
// with where it came from. The latest row per user/channel/purpose is in force.
const consentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    channel: { type: String, enum: ["push", "whatsapp", "email", "sms", "inapp"], required: true },
    purpose: { type: String, enum: ["transactional", "marketing"], required: true },
    status: { type: String, enum: ["granted", "revoked"], required: true },
    source: { type: String, default: "app" }, // app_toggle, whatsapp_keyword, checkout, import, unsubscribe_link, admin
    policyVersion: { type: String, default: "1" },
    ip: { type: String, default: null },
    deviceId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

consentSchema.index({ user: 1, channel: 1, purpose: 1, createdAt: -1 });
consentSchema.index({ createdAt: -1 });

export const UserConsent = mongoose.model("UserConsent", consentSchema);

export async function recordConsent({ userId, channel, purpose = "marketing", granted, source = "app", ip = null, deviceId = null }) {
  return UserConsent.create({ user: userId, channel, purpose, status: granted ? "granted" : "revoked", source, ip, deviceId });
}

/** Current marketing consent per channel for a user (latest row wins). */
export async function currentConsents(userId) {
  const rows = await UserConsent.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { channel: "$channel", purpose: "$purpose" }, status: { $first: "$status" }, at: { $first: "$createdAt" }, source: { $first: "$source" } } },
  ]);
  return rows.map((row) => ({ channel: row._id.channel, purpose: row._id.purpose, status: row.status, at: row.at, source: row.source }));
}
