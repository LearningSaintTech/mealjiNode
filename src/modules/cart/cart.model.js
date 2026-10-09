import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const lineSchema = new mongoose.Schema(
  {
    lineId: { type: String, required: true },
    kind: { type: String, enum: ["dish", "combo"], default: "dish" },
    dish: { type: ObjectId, ref: "KitchenDish", default: null },
    combo: { type: ObjectId, ref: "KitchenCombo", default: null },
    qty: { type: Number, required: true, min: 1, max: 50 },
    portionId: { type: String, default: null },
    mealUpgrade: { type: Boolean, default: false },
    optionIds: { type: [String], default: [] },
    specialInstructions: { type: String, default: null, maxlength: 200 },
    // Price seen when added, to tell the customer when it changed.
    seenUnitPricePaise: { type: Number, default: null },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

// One cart per customer, bound to one kitchen.
const cartSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true, unique: true },
    kitchen: { type: ObjectId, ref: "Kitchen", default: null },
    items: { type: [lineSchema], default: [] },
    couponCode: { type: String, default: null },
    tipPaise: { type: Number, default: 0 },
    usePoints: { type: Boolean, default: false },
    chefNote: { type: String, default: null, maxlength: 300 },
    deliveryMode: { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    address: { type: ObjectId, ref: "Address", default: null },
    scheduledFor: { type: Date, default: null },
  },
  // Two quick taps must never overwrite each other: a save fails when the
  // cart changed since it was read, and cart.service retries on fresh data.
  { timestamps: true, optimisticConcurrency: true },
);
cartSchema.index({ updatedAt: -1 });

export const Cart = mongoose.model("Cart", cartSchema);
