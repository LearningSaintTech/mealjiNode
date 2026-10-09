import mongoose from "mongoose";
import { memoCache } from "../../common/memoCache.js";

// Active, placed kitchens: read on almost every customer request.
export const kitchenCache = memoCache(5_000);

const kitchenSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    contactName: { type: String, required: true, trim: true, maxlength: 80 },
    countryCode: { type: String, required: true, default: "+91", trim: true },
    phoneNumber: { type: String, required: true, trim: true },
    addressLine: { type: String, required: true, trim: true, maxlength: 160 },
    area: { type: String, default: null, trim: true, maxlength: 80 },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    state: { type: String, default: null, trim: true, maxlength: 60 },
    postalCode: { type: String, default: null, trim: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    serviceRadiusKm: { type: Number, required: true, min: 0.5, max: 25 },
    opensAt: { type: String, required: true, trim: true },
    closesAt: { type: String, required: true, trim: true },
    serviceNote: { type: String, default: "", trim: true, maxlength: 280 },
    status: {
      type: String,
      enum: ["onboarding", "active", "paused"],
      default: "onboarding",
    },
    acceptingOrders: { type: Boolean, default: false },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Optional per-weekday hours (0 = Sunday). Days not listed use opensAt/closesAt.
    weeklyHours: {
      type: [{
        _id: false,
        weekday: { type: Number, min: 0, max: 6, required: true },
        closed: { type: Boolean, default: false },
        opensAt: { type: String, default: null },
        closesAt: { type: String, default: null },
      }],
      default: [],
    },
    // Holiday / closure calendar (IST dates, YYYY-MM-DD).
    closures: {
      type: [{ _id: false, date: { type: String, required: true }, reason: { type: String, default: "" } }],
      default: [],
    },
    // Invoices for this kitchen's orders are issued by this entity.
    billingEntity: { type: mongoose.Schema.Types.ObjectId, ref: "BillingEntity", default: null },
    // Public "About the chef" page and photos (kitchen admin edits if allowed).
    about: {
      chefName: { type: String, default: null, maxlength: 80 },
      title: { type: String, default: null, maxlength: 120 },
      story: { type: String, default: null, maxlength: 2000 },
      tagline: { type: String, default: null, maxlength: 60 },
      quote: { type: String, default: null, maxlength: 240 },
      standardTitle: { type: String, default: null, maxlength: 60 },
      pillars: { type: [{ _id: false, icon: { type: String, default: null }, title: { type: String, required: true }, description: { type: String, default: null } }], default: [] },
      ctaLabel: { type: String, default: null, maxlength: 30 },
      ctaDeepLink: { type: String, default: null, maxlength: 300 },
      imageUrl: { type: String, default: null, maxlength: 500 },
      gallery: { type: [String], default: [] },
    },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

kitchenSchema.index({ phoneNumber: 1 }, { unique: true });
kitchenSchema.index({ user: 1 }, { unique: true, sparse: true });
kitchenSchema.index({ status: 1, createdAt: -1 });

// Any write clears the short in-process kitchen cache (kitchen.repository.js).
const kitchenChanged = () => kitchenCache.clear();
kitchenSchema.post("save", kitchenChanged);
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"]) kitchenSchema.post(op, kitchenChanged);

export const Kitchen = mongoose.model("Kitchen", kitchenSchema);
