import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// Signed points ledger. The balance on the user is a cache of the sum; every
// change is a row here, deduplicated by `dedupeKey` so replays never double-count.
const rewardTransactionSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    points: { type: Number, required: true }, // + earned, - spent/expired/reversed
    type: { type: String, enum: ["earned", "redeemed", "expired", "reversed", "adjusted"], required: true },
    source: { type: String, required: true }, // order, review, referral, birthday, checkout, reward, admin, expiry, cancellation
    referenceType: { type: String, default: null },
    referenceId: { type: String, default: null },
    title: { type: String, required: true, maxlength: 120 },
    // Earned rows expire; spending consumes the oldest first (tracked by `remaining`).
    remaining: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    dedupeKey: { type: String, default: undefined },
    actor: { userId: String, name: String },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

rewardTransactionSchema.index({ user: 1, createdAt: -1 });
rewardTransactionSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
rewardTransactionSchema.index({ type: 1, expiresAt: 1, remaining: 1 });

export const RewardTransaction = mongoose.model("RewardTransaction", rewardTransactionSchema);
