import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const paymentSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    refType: { type: String, enum: ["order", "subscription"], required: true },
    refId: { type: ObjectId, required: true },
    kitchen: { type: ObjectId, ref: "Kitchen", default: null },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    method: { type: String, default: null }, // upi, card, netbanking, wallet, cod, autopay, link
    gateway: { type: String, enum: ["razorpay", "test", "cod"], required: true },
    gatewayOrderId: { type: String, default: null },
    gatewayPaymentId: { type: String, default: null },
    gatewayLinkId: { type: String, default: null },
    gatewaySubscriptionId: { type: String, default: null },
    status: { type: String, enum: ["created", "captured", "failed", "refunded", "partially_refunded", "cancelled"], default: "created" },
    failureReason: { type: String, default: null },
    feePaise: { type: Number, default: 0 },
    taxOnFeePaise: { type: Number, default: 0 },
    settlementId: { type: String, default: null },
    capturedAt: { type: Date, default: null },
    refundedPaise: { type: Number, default: 0 },
    cycle: { type: Number, default: null }, // subscription billing cycle number
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);
paymentSchema.index({ gatewayOrderId: 1 }, { sparse: true });
paymentSchema.index({ gatewayPaymentId: 1 }, { sparse: true });
paymentSchema.index({ gatewayLinkId: 1 }, { sparse: true });
paymentSchema.index({ refType: 1, refId: 1, createdAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
export const Payment = mongoose.model("Payment", paymentSchema);

const refundSchema = new mongoose.Schema(
  {
    payment: { type: ObjectId, ref: "Payment", default: null },
    order: { type: ObjectId, ref: "Order", default: null },
    subscription: { type: ObjectId, ref: "Subscription", default: null },
    user: { type: ObjectId, ref: "User", required: true },
    kitchen: { type: ObjectId, ref: "Kitchen", default: null },
    amountPaise: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true, maxlength: 300 },
    // pending_approval → processing → processed | failed; or rejected.
    status: { type: String, enum: ["pending_approval", "processing", "processed", "failed", "rejected"], default: "processing" },
    gatewayRefundId: { type: String, default: null },
    requestedBy: { userId: String, name: String, role: String },
    reviewedBy: { userId: String, name: String },
    reviewNote: { type: String, default: null },
    processedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);
refundSchema.index({ status: 1, createdAt: -1 });
refundSchema.index({ order: 1 });
refundSchema.index({ gatewayRefundId: 1 }, { sparse: true });
export const Refund = mongoose.model("Refund", refundSchema);

// Raw provider webhooks, deduplicated by the provider's event id.
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: ["received", "processed", "failed", "ignored"], default: "received" },
    error: { type: String, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: -1 });
export const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);
