import mongoose from "mongoose";

const currentLocationSchema = new mongoose.Schema(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    locationText: { type: String, required: true, trim: true },
    area: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: null },
    placeId: { type: String, default: null },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const subscriptionSchema = new mongoose.Schema(
  {
    planCode: { type: String, default: null },
    status: {
      type: String,
      enum: ["none", "active", "paused", "expired", "cancelled"],
      default: "none",
    },
    subscribedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    countryCode: { type: String, required: true, default: "+91", trim: true },
    phoneNumber: { type: String, required: true, trim: true },
    role: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true },
    kitchen: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", default: null },
    isActive: { type: Boolean, default: false },
    isNumberVerified: { type: Boolean, default: false },
    subscription: { type: subscriptionSchema, default: () => ({}) },
    currentLocation: { type: currentLocationSchema, default: null },
    lastLoginAt: { type: Date, default: null },
    // Set when an admin suspends the account; never cleared by a sign-in.
    suspendedAt: { type: Date, default: null },
    // Tokens issued before this instant are rejected (sign out everywhere).
    sessionsRevokedAt: { type: Date, default: null },

    // Customer profile (Phase 1).
    email: { type: String, default: null, trim: true, lowercase: true, maxlength: 120 },
    emailVerified: { type: Boolean, default: false },
    dob: { type: String, default: null }, // YYYY-MM-DD
    gender: { type: String, enum: ["male", "female", "other", "prefer_not", null], default: null },
    avatarUrl: { type: String, default: null, maxlength: 500 },
    preferences: {
      language: { type: String, default: "en" },
      vegOnly: { type: Boolean, default: false },
      channels: {
        push: { type: Boolean, default: true },
        whatsapp: { type: Boolean, default: false },
        email: { type: Boolean, default: true },
        sms: { type: Boolean, default: true },
      },
      topics: {
        offers: { type: Boolean, default: true },
        rewards: { type: Boolean, default: true },
        account: { type: Boolean, default: true },
      },
    },
    // Soft delete: the account is closed now and anonymised by the purge job later.
    deletedAt: { type: Date, default: null },
    deletionReason: { type: String, default: null, maxlength: 300 },

    // Loyalty & referrals (Phase 3). The points balance is a cache of the ledger.
    referralCode: { type: String, default: undefined, trim: true, uppercase: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    pointsBalance: { type: Number, default: 0 },
    lifetimePoints: { type: Number, default: 0 },
    tier: { type: String, default: null },
    birthdayRewardYear: { type: Number, default: null },

    // Attribution & engagement (Phase 4).
    acquisition: {
      source: { type: String, default: null },
      medium: { type: String, default: null },
      campaign: { type: String, default: null },
    },
    lastAppOpenAt: { type: Date, default: null },
    // Demo/seed accounts: in-app messages work, but no SMS, WhatsApp, email or
    // push is ever sent, because their phone numbers may belong to real people.
    isDemo: { type: Boolean, default: false },
    platform: { type: String, default: null },
    appVersion: { type: String, default: null },
  },
  { timestamps: true },
);

userSchema.index({ countryCode: 1, phoneNumber: 1 }, { unique: true });
userSchema.index({ phoneNumber: 1 });
userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ kitchen: 1 }, { sparse: true });
userSchema.index({ referralCode: 1 }, { unique: true, sparse: true });
userSchema.index({ deletedAt: 1 }, { sparse: true });
userSchema.index({ email: 1 }, { sparse: true });

export const User = mongoose.model("User", userSchema);
