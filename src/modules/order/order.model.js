import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const itemSchema = new mongoose.Schema(
  {
    lineId: String,
    kind: { type: String, enum: ["dish", "combo"], default: "dish" },
    dish: { type: ObjectId, ref: "KitchenDish", default: null },
    combo: { type: ObjectId, ref: "KitchenCombo", default: null },
    name: String,
    imageUrl: String,
    isVeg: Boolean,
    qty: Number,
    portion: { type: mongoose.Schema.Types.Mixed, default: null },
    mealUpgrade: { type: mongoose.Schema.Types.Mixed, default: null },
    options: { type: [mongoose.Schema.Types.Mixed], default: [] },
    specialInstructions: { type: String, default: null },
    unitPricePaise: Number,
    totalPaise: Number,
    dishIds: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{dishId, qty}] for stock and stats
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    status: String,
    at: { type: Date, default: Date.now },
    by: { userId: String, role: String, name: String },
    note: { type: String, default: null },
  },
  { _id: false },
);

const stepSchema = new mongoose.Schema(
  {
    key: String,
    label: String,
    state: { type: String, enum: ["pending", "active", "done"], default: "pending" },
    at: { type: Date, default: null },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true },
    user: { type: ObjectId, ref: "User", required: true },
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    kitchenName: { type: String, default: null },
    city: { type: String, default: null },
    items: { type: [itemSchema], default: [] },
    customer: { name: String, phone: String },
    address: { type: mongoose.Schema.Types.Mixed, default: null },
    deliveryMode: { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    scheduledFor: { type: Date, default: null },
    bill: { type: mongoose.Schema.Types.Mixed, required: true },
    couponCode: { type: String, default: null },
    pointsUsed: { type: Number, default: 0 },
    paymentMethod: { type: String, required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "cod_pending", "cod_collected", "refunded", "partially_refunded"],
      default: "pending",
    },
    status: {
      type: String,
      enum: ["payment_pending", "payment_failed", "placed", "accepted", "preparing", "ready", "dispatched", "delivered", "cancelled"],
      required: true,
    },
    statusHistory: { type: [historySchema], default: [] },
    kitchenSteps: { type: [stepSchema], default: [] },
    etaMinutes: { type: Number, default: null },
    estimatedDeliveryAt: { type: Date, default: null },
    placedAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    readyAt: { type: Date, default: null },
    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null }, // unpaid online order expiry
    cancellation: {
      by: { type: String, default: null }, // customer, kitchen, admin, system
      reason: { type: String, default: null },
      note: { type: String, default: null },
    },
    chefNote: { type: String, default: null },
    rating: {
      food: { type: Number, default: null },
      delivery: { type: Number, default: null },
      tags: { type: [String], default: [] },
      comment: { type: String, default: null },
      dishRatings: { type: [mongoose.Schema.Types.Mixed], default: [] },
      at: { type: Date, default: null },
    },
    rider: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      vehicleNumber: { type: String, default: null },
    },
    deliveryJob: { type: ObjectId, ref: "DeliveryJob", default: null },
    invoice: { type: ObjectId, ref: "Invoice", default: null },
    refundedPaise: { type: Number, default: 0 },
    isFirstOrder: { type: Boolean, default: false },
    slaAlertedAt: { type: Date, default: null },
    source: { type: String, default: "app" },
    platform: { type: String, default: null },
  },
  { timestamps: true },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ kitchen: 1, status: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ status: 1, expiresAt: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ "customer.phone": 1 });

export const Order = mongoose.model("Order", orderSchema);
