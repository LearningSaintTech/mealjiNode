import mongoose from "mongoose";
import { memoCache } from "../../common/memoCache.js";

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const SLOT_KEYS = ["breakfast", "lunch", "dinner"];
export const NO_SELECTION_POLICIES = ["auto_shift", "chef_default", "repeat_last", "skip"];

// Admin-built plans. Nothing about a plan lives in code; subscribers keep a
// snapshot of the plan they bought, so editing or retiring a plan never
// changes existing subscriptions.
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    name: { type: String, required: true, maxlength: 60 },
    subtitle: { type: String, default: null, maxlength: 120 },
    badge: { type: String, default: null, maxlength: 30 },
    description: { type: String, default: "", maxlength: 1000 },
    imageUrl: { type: String, default: null },
    pricePaise: { type: Number, required: true, min: 0 },
    mrpPaise: { type: Number, default: null },
    cycleDays: { type: Number, required: true, min: 1, max: 366 },
    cycleLabel: { type: String, default: "Monthly" },
    mealsPerDay: { type: Number, default: 1, min: 1, max: 3 },
    slots: { type: [String], default: ["lunch"] },
    maxItemsPerMeal: { type: Number, default: 5, min: 1, max: 20 },
    minItemsPerMeal: { type: Number, default: 1, min: 1, max: 20 },
    categoryIds: { type: [ObjectId], default: [] }, // empty = any dish in the slot menu
    deliveryIncluded: { type: Boolean, default: true },
    deliveryFeePaise: { type: Number, default: 0 },
    benefits: { type: [String], default: [] },
    perks: { freeDeliveryOnOrders: { type: Boolean, default: true }, orderDiscountPercent: { type: Number, default: 0 } },
    kitchens: { type: [ObjectId], default: [] }, // empty = every kitchen (within cities)
    cities: { type: [String], default: [] },
    billingMethods: { type: [String], default: ["autopay", "link"] },
    noSelectionPolicy: { type: String, enum: NO_SELECTION_POLICIES, default: "auto_shift" },
    autoShiftCountsTowardLimit: { type: Boolean, default: false },
    maxAutoShiftsPerCycle: { type: Number, default: 0 }, // 0 = no limit
    autoShiftFallback: { type: String, enum: ["skip", "chef_default"], default: "skip" },
    maxShiftsPerCycle: { type: Number, default: 4 },
    activeDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // meal days of the week
    renewalPriceMode: { type: String, enum: ["keep", "new_price"], default: "keep" },
    isPopular: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ["draft", "active", "retired"], default: "draft" },
    activeFrom: { type: Date, default: null },
    activeTo: { type: Date, default: null },
  },
  { timestamps: true },
);
planSchema.index({ code: 1 }, { unique: true });
planSchema.index({ status: 1, sortOrder: 1 });
// Plan edits clear the short in-process cache of live plans (plan.service.js).
export const livePlanCache = memoCache(30_000);
planSchema.post("save", () => livePlanCache.clear());
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"]) planSchema.post(op, () => livePlanCache.clear());
export const SubscriptionPlan = mongoose.model("SubscriptionPlan", planSchema);

// A kitchen's meal slot. Every time is set by the kitchen / admin (IST).
const mealSlotSchema = new mongoose.Schema(
  {
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    key: { type: String, enum: SLOT_KEYS, required: true },
    name: { type: String, required: true, maxlength: 30 },
    windowStart: { type: String, required: true },
    windowEnd: { type: String, required: true },
    cutoffDay: { type: String, enum: ["same_day", "previous_day"], default: "same_day" },
    cutoffTime: { type: String, required: true },
    prepStart: { type: String, required: true },
    dispatchTime: { type: String, required: true },
    capacity: { type: Number, default: 0 }, // 0 = unlimited
    activeDays: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
mealSlotSchema.index({ kitchen: 1, key: 1 }, { unique: true });
export const MealSlot = mongoose.model("MealSlot", mealSlotSchema);

// What a kitchen offers in a slot: for one date, or every week on a weekday.
const slotMenuSchema = new mongoose.Schema(
  {
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    slot: { type: String, enum: SLOT_KEYS, required: true },
    date: { type: String, default: null }, // YYYY-MM-DD (overrides the weekday menu)
    weekday: { type: Number, default: null }, // 0-6 template
    dishes: { type: [ObjectId], default: [] },
    defaultDishes: { type: [ObjectId], default: [] }, // chef's default meal
    note: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: true },
);
slotMenuSchema.index({ kitchen: 1, slot: 1, date: 1, weekday: 1 }, { unique: true });
export const SlotMenu = mongoose.model("SlotMenu", slotMenuSchema);

const subscriptionSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    plan: { type: ObjectId, ref: "SubscriptionPlan", required: true },
    planSnapshot: { type: Mixed, required: true },
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    address: { type: Mixed, required: true },
    addressId: { type: ObjectId, ref: "Address", default: null },
    status: {
      type: String,
      enum: ["pending_payment", "active", "pause_scheduled", "paused", "cancel_scheduled", "past_due", "cancelled", "expired"],
      default: "pending_payment",
    },
    billingMethod: { type: String, enum: ["autopay", "link"], default: "link" },
    startDate: { type: String, required: true },
    cycle: { type: Number, default: 0 },
    currentPeriodStart: { type: String, default: null },
    currentPeriodEnd: { type: String, default: null },
    validTill: { type: String, default: null }, // last meal day, extended by shifts
    nextBillingDate: { type: String, default: null },
    renewalPricePaise: { type: Number, default: null },
    autoRenew: { type: Boolean, default: true },
    pause: { startsOn: String, resumesOn: String, months: Number, requestedAt: Date },
    scheduledChange: { plan: { type: ObjectId, ref: "SubscriptionPlan", default: null }, planName: String, effectiveOn: String },
    cancellation: { reasonId: String, reason: String, comment: String, effectiveOn: String, requestedAt: Date },
    gatewaySubscriptionId: { type: String, default: null },
    mandateStatus: { type: String, default: null },
    paymentLink: { url: String, linkId: String, amountPaise: Number, cycle: Number, sentAt: Date },
    shiftsThisCycle: { type: Number, default: 0 },
    autoShiftsThisCycle: { type: Number, default: 0 },
    renewalAttempts: { type: Number, default: 0 },
    pastDueSince: { type: String, default: null },
    remindersSent: { type: [String], default: [] }, // "cycle:days" keys
    expiresPaymentAt: { type: Date, default: null },
    history: { type: [{ _id: false, at: Date, event: String, note: String, by: String }], default: [] },
  },
  { timestamps: true },
);
subscriptionSchema.index({ user: 1, status: 1 });
subscriptionSchema.index({ status: 1, nextBillingDate: 1 });
subscriptionSchema.index({ kitchen: 1, status: 1 });
subscriptionSchema.index({ gatewaySubscriptionId: 1 }, { sparse: true });
export const Subscription = mongoose.model("Subscription", subscriptionSchema);

// One meal: subscription × date × slot.
const mealSelectionSchema = new mongoose.Schema(
  {
    subscription: { type: ObjectId, ref: "Subscription", required: true },
    user: { type: ObjectId, ref: "User", required: true },
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    date: { type: String, required: true },
    slot: { type: String, enum: SLOT_KEYS, required: true },
    items: { type: [{ _id: false, dish: { type: ObjectId, ref: "KitchenDish" }, name: String, qty: { type: Number, default: 1 }, isVeg: Boolean }], default: [] },
    // open → selected → locked → out_for_delivery → delivered; or shifted / skipped.
    status: { type: String, enum: ["open", "selected", "locked", "out_for_delivery", "delivered", "shifted", "skipped"], default: "open" },
    source: { type: String, enum: ["customer", "chef_default", "repeat_last", "admin", null], default: null },
    cutoffAt: { type: Date, required: true },
    shiftedTo: { type: String, default: null },
    shiftedFrom: { type: String, default: null },
    shiftKind: { type: String, enum: ["manual", "auto", null], default: null },
    address: { type: Mixed, default: null },
    deliveryJob: { type: ObjectId, ref: "DeliveryJob", default: null },
    lockedAt: Date,
    deliveredAt: Date,
    timeline: { type: [{ _id: false, status: String, at: Date }], default: [] },
  },
  { timestamps: true },
);
mealSelectionSchema.index({ subscription: 1, date: 1, slot: 1 }, { unique: true });
mealSelectionSchema.index({ kitchen: 1, date: 1, slot: 1, status: 1 });
mealSelectionSchema.index({ user: 1, date: 1 });
export const MealSelection = mongoose.model("MealSelection", mealSelectionSchema);
