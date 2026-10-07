import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const optionSchema = new mongoose.Schema(
  {
    optionId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    pricePaise: { type: Number, default: 0, min: 0 },
    isVeg: { type: Boolean, default: true },
    isAvailable: { type: Boolean, default: true },
  },
  { _id: false },
);

const groupSchema = new mongoose.Schema(
  {
    groupId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    minSelect: { type: Number, default: 0, min: 0 },
    maxSelect: { type: Number, default: 1, min: 1 },
    options: { type: [optionSchema], default: [] },
  },
  { _id: false },
);

const portionSchema = new mongoose.Schema(
  {
    portionId: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    pricePaise: { type: Number, required: true, min: 0 },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

// Content shared by master dishes and kitchen dishes.
const dishContent = {
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: "", trim: true, maxlength: 600 },
  story: { type: String, default: "", trim: true, maxlength: 1500 },
  images: { type: [String], default: [] },
  isVeg: { type: Boolean, default: true },
  spicyLevel: { type: Number, default: 0, min: 0, max: 3 },
  calories: { type: Number, default: null },
  servesCount: { type: Number, default: 1 },
  highlights: { type: [String], default: [] },
  tags: { type: [String], default: [] },
  cuisine: { type: String, default: null, trim: true, maxlength: 40 },
  portions: { type: [portionSchema], default: [] },
  customizationGroups: { type: [groupSchema], default: [] },
  mealUpgrade: {
    label: { type: String, default: null },
    description: { type: String, default: null },
    pricePaise: { type: Number, default: null },
  },
};

// ---- Master library (platform) ----

const masterCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    icon: { type: String, default: null },
    subtitle: { type: String, default: null, maxlength: 120 },
    imageUrl: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const MasterCategory = mongoose.model("MasterCategory", masterCategorySchema);

const masterDishSchema = new mongoose.Schema(
  {
    ...dishContent,
    category: { type: ObjectId, ref: "MasterCategory", default: null },
    suggestedPricePaise: { type: Number, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
masterDishSchema.index({ name: "text", tags: "text", cuisine: "text" });
export const MasterDish = mongoose.model("MasterDish", masterDishSchema);

// ---- Kitchen menu (what customers see) ----

const kitchenCategorySchema = new mongoose.Schema(
  {
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    masterCategory: { type: ObjectId, ref: "MasterCategory", default: null },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    icon: { type: String, default: null },
    subtitle: { type: String, default: null, maxlength: 120 },
    imageUrl: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
kitchenCategorySchema.index({ kitchen: 1, sortOrder: 1 });
export const KitchenCategory = mongoose.model("KitchenCategory", kitchenCategorySchema);

const kitchenDishSchema = new mongoose.Schema(
  {
    ...dishContent,
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    category: { type: ObjectId, ref: "KitchenCategory", default: null },
    masterDish: { type: ObjectId, ref: "MasterDish", default: null },
    pricePaise: { type: Number, required: true, min: 0 },
    originalPricePaise: { type: Number, default: null },
    packagingPaise: { type: Number, default: 0 },
    isBestseller: { type: Boolean, default: false },
    badge: { type: String, default: null, maxlength: 30 },
    preparationMinutes: { type: Number, default: null },
    // Kitchen control: sold out today vs removed from the menu.
    isAvailable: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    dailyStockLimit: { type: Number, default: 0 }, // 0 = unlimited
    stock: { date: { type: String, default: null }, sold: { type: Number, default: 0 } },
    availableSlots: { type: [String], default: [] }, // empty = all day
    availableDays: { type: [Number], default: [] }, // 0-6, empty = every day
    sortOrder: { type: Number, default: 0 },
    // live | pending (waiting for platform approval) | rejected
    approvalStatus: { type: String, enum: ["live", "pending", "rejected"], default: "live" },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    orderCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
kitchenDishSchema.index({ kitchen: 1, category: 1, sortOrder: 1 });
kitchenDishSchema.index({ kitchen: 1, isActive: 1, approvalStatus: 1 });
kitchenDishSchema.index({ name: "text", tags: "text", cuisine: "text", description: "text" });
export const KitchenDish = mongoose.model("KitchenDish", kitchenDishSchema);

const kitchenComboSchema = new mongoose.Schema(
  {
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    subtitle: { type: String, default: null, maxlength: 200 },
    imageUrl: { type: String, default: null },
    pricePaise: { type: Number, required: true, min: 0 },
    originalPricePaise: { type: Number, default: null },
    badge: { type: String, default: null, maxlength: 30 },
    serves: { type: Number, default: 1 },
    items: [{ _id: false, dish: { type: ObjectId, ref: "KitchenDish", required: true }, qty: { type: Number, default: 1, min: 1 } }],
    filterTags: { type: [String], default: [] },
    isSignature: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    approvalStatus: { type: String, enum: ["live", "pending", "rejected"], default: "live" },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
kitchenComboSchema.index({ kitchen: 1, sortOrder: 1 });
export const KitchenCombo = mongoose.model("KitchenCombo", kitchenComboSchema);

// Kitchen changes waiting for platform approval (menu policy).
const menuChangeRequestSchema = new mongoose.Schema(
  {
    kitchen: { type: ObjectId, ref: "Kitchen", required: true },
    entityType: { type: String, enum: ["dish", "combo"], required: true },
    entityId: { type: ObjectId, required: true },
    entityName: { type: String, default: null },
    action: { type: String, enum: ["create", "update"], required: true },
    changes: { type: mongoose.Schema.Types.Mixed, default: {} },
    before: { type: mongoose.Schema.Types.Mixed, default: {} },
    reason: { type: String, default: null },
    requestedBy: { userId: String, name: String },
    status: { type: String, enum: ["pending", "approved", "rejected", "superseded"], default: "pending" },
    reviewedBy: { userId: String, name: String },
    reviewNote: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
menuChangeRequestSchema.index({ status: 1, createdAt: -1 });
menuChangeRequestSchema.index({ kitchen: 1, status: 1 });
export const MenuChangeRequest = mongoose.model("MenuChangeRequest", menuChangeRequestSchema);
