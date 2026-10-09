import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    title: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 300 },
    terms: { type: [String], default: [] },
    type: { type: String, enum: ["flat", "percent", "free_delivery"], required: true },
    value: { type: Number, default: 0 }, // paise for flat, percent for percent
    maxDiscountPaise: { type: Number, default: 0 }, // 0 = no cap (percent)
    minOrderPaise: { type: Number, default: 0 },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    usageLimit: { type: Number, default: 0 }, // 0 = unlimited
    perUserLimit: { type: Number, default: 1 }, // 0 = unlimited
    firstOrderOnly: { type: Boolean, default: false },
    cities: { type: [String], default: [] },
    kitchens: { type: [ObjectId], default: [] },
    segment: { type: ObjectId, ref: "Segment", default: null },
    paymentMethods: { type: [String], default: [] }, // upi, card, cod… empty = any
    // Platform coupons are paid by MealJi; kitchen-funded offers by one kitchen.
    fundedBy: { type: String, enum: ["platform", "kitchen"], default: "platform" },
    kitchen: { type: ObjectId, ref: "Kitchen", default: null },
    approvalStatus: { type: String, enum: ["live", "pending", "rejected"], default: "live" },
    isPublic: { type: Boolean, default: true }, // listed in "available offers"
    isActive: { type: Boolean, default: true },
    usedCount: { type: Number, default: 0 },
    createdBy: { type: ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ isActive: 1, validTo: 1 });
export const Coupon = mongoose.model("Coupon", couponSchema);

const redemptionSchema = new mongoose.Schema(
  {
    coupon: { type: ObjectId, ref: "Coupon", required: true },
    code: { type: String, required: true },
    user: { type: ObjectId, ref: "User", required: true },
    order: { type: ObjectId, ref: "Order", default: null },
    discountPaise: { type: Number, required: true },
    // reserved at placement, redeemed on payment, released on failure/cancel.
    status: { type: String, enum: ["reserved", "redeemed", "released"], default: "reserved" },
  },
  { timestamps: true },
);
redemptionSchema.index({ coupon: 1, user: 1, status: 1 });
// The cart counts a customer's past redemptions on every view: needs user first.
redemptionSchema.index({ user: 1, status: 1 });
redemptionSchema.index({ order: 1 }, { unique: true, sparse: true });
export const CouponRedemption = mongoose.model("CouponRedemption", redemptionSchema);
