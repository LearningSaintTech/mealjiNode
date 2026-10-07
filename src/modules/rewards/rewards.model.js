import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// Reward catalogue: what points can be swapped for. Redeeming issues a personal
// coupon (dish, flat or percent off) that the customer applies at checkout.
const rewardSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 300 },
    imageUrl: { type: String, default: null },
    points: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: ["flat", "percent", "free_delivery", "dish"], required: true },
    value: { type: Number, default: 0 }, // paise (flat / dish value cap) or percent
    maxDiscountPaise: { type: Number, default: 0 },
    minOrderPaise: { type: Number, default: 0 },
    dish: { type: ObjectId, ref: "KitchenDish", default: null },
    validDays: { type: Number, default: 30 },
    stock: { type: Number, default: 0 }, // 0 = unlimited
    redeemedCount: { type: Number, default: 0 },
    tiers: { type: [String], default: [] }, // empty = every tier
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Reward = mongoose.model("Reward", rewardSchema);

const redemptionSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    reward: { type: ObjectId, ref: "Reward", required: true },
    rewardName: String,
    points: Number,
    couponCode: String,
    expiresAt: Date,
    status: { type: String, enum: ["issued", "used", "expired"], default: "issued" },
  },
  { timestamps: true },
);
redemptionSchema.index({ user: 1, createdAt: -1 });
export const RewardRedemption = mongoose.model("RewardRedemption", redemptionSchema);

const referralSchema = new mongoose.Schema(
  {
    referrer: { type: ObjectId, ref: "User", required: true },
    referee: { type: ObjectId, ref: "User", required: true },
    code: { type: String, required: true },
    status: { type: String, enum: ["pending", "converted", "rejected"], default: "pending" },
    rejectReason: { type: String, default: null },
    order: { type: ObjectId, ref: "Order", default: null },
    convertedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
referralSchema.index({ referee: 1 }, { unique: true });
referralSchema.index({ referrer: 1, status: 1 });
export const Referral = mongoose.model("Referral", referralSchema);
