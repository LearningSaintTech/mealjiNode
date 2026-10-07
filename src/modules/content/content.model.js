import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

export const BANNER_PLACEMENTS = ["home_hero", "home_promo", "home_combos", "home_how_we_cook", "menu_hero", "offers"];

const bannerSchema = new mongoose.Schema(
  {
    placement: { type: String, enum: BANNER_PLACEMENTS, required: true },
    eyebrow: { type: String, default: null, maxlength: 60 },
    title: { type: String, required: true, maxlength: 120 },
    highlight: { type: String, default: null, maxlength: 60 },
    subtitle: { type: String, default: null, maxlength: 200 },
    imageUrl: { type: String, default: null },
    ctaLabel: { type: String, default: null, maxlength: 40 },
    deepLink: { type: String, default: null, maxlength: 300 },
    couponCode: { type: String, default: null, maxlength: 30 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // Targeting: empty lists mean everyone.
    cities: { type: [String], default: [] },
    kitchens: { type: [ObjectId], default: [] },
    segment: { type: ObjectId, ref: "Segment", default: null },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true },
);
bannerSchema.index({ placement: 1, isActive: 1, sortOrder: 1 });
export const Banner = mongoose.model("Banner", bannerSchema);

const slideSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, maxlength: 120 },
    subtitle: { type: String, default: null, maxlength: 240 },
    imageUrl: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const OnboardingSlide = mongoose.model("OnboardingSlide", slideSchema);

export const SECTION_TYPES = ["banners", "categories", "popular", "combos", "usual", "recommended", "subscription_promo", "how_we_cook", "features", "reorder"];

const homeSectionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 40 },
    type: { type: String, enum: SECTION_TYPES, required: true },
    title: { type: String, default: null, maxlength: 80 },
    subtitle: { type: String, default: null, maxlength: 160 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    // e.g. { placement: "home_promo" } for banners, { items: [...] } for features, { limit: 8 }.
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);
export const HomeSection = mongoose.model("HomeSection", homeSectionSchema);
