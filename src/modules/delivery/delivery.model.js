import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

// Delivery partner accounts (3PL). The built-in "manual" and "self" providers
// need no account; real partners are added here once chosen.
const providerAccountSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true }, // porter, shadowfax, borzo… (adapter key)
    name: { type: String, required: true, maxlength: 80 },
    credentials: { type: mongoose.Schema.Types.Mixed, default: {} }, // stored encrypted at rest by the DB layer in production
    cities: { type: [String], default: [] },
    kitchens: { type: [ObjectId], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, minimize: false },
);
export const DeliveryProviderAccount = mongoose.model("DeliveryProviderAccount", providerAccountSchema);

const deliveryJobSchema = new mongoose.Schema(
  {
    order: { type: ObjectId, ref: "Order", default: null },
    mealDrop: { type: ObjectId, ref: "MealSelection", default: null },
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    provider: { type: String, required: true },
    providerJobId: { type: String, default: null },
    // pending → booked → assigned → picked_up → delivered; or cancelled / failed.
    status: { type: String, enum: ["pending", "booked", "assigned", "picked_up", "delivered", "cancelled", "failed"], default: "pending" },
    quotePaise: { type: Number, default: null },
    costPaise: { type: Number, default: null },
    rider: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      vehicleNumber: { type: String, default: null },
    },
    trackingUrl: { type: String, default: null },
    pickup: { latitude: Number, longitude: Number, address: String },
    drop: { latitude: Number, longitude: Number, address: String },
    attempts: { type: Number, default: 1 },
    failureReason: { type: String, default: null },
    bookedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    lastLocation: { lat: Number, lng: Number, heading: Number, speed: Number, at: Date },
    history: { type: [{ _id: false, status: String, at: Date, note: String, by: String }], default: [] },
  },
  { timestamps: true },
);
deliveryJobSchema.index({ order: 1 });
deliveryJobSchema.index({ kitchen: 1, status: 1, createdAt: -1 });
deliveryJobSchema.index({ provider: 1, providerJobId: 1 }, { sparse: true });
deliveryJobSchema.index({ createdAt: -1 });
export const DeliveryJob = mongoose.model("DeliveryJob", deliveryJobSchema);
