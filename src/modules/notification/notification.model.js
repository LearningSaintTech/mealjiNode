import mongoose from "mongoose";

const { ObjectId, Mixed } = mongoose.Schema.Types;

export const CHANNELS = ["push", "inapp", "whatsapp", "sms", "email"];
export const INBOX_CATEGORIES = ["orders", "offers", "rewards", "account"];

// Admin-editable message templates. Code ships defaults for every key; a saved
// template overrides the default. Versions are kept so campaigns can pin one.
const templateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    version: { type: Number, default: 1 },
    name: { type: String, default: null },
    category: { type: String, enum: ["transactional", "marketing"], default: "transactional" },
    inboxCategory: { type: String, enum: INBOX_CATEGORIES, default: "account" },
    channels: {
      push: { title: String, body: String, imageUrl: String, deepLink: String },
      inapp: { title: String, body: String, icon: String, iconColor: String, deepLink: String },
      whatsapp: { providerTemplateName: String, language: { type: String, default: "en" }, waCategory: String, variables: [String], approvalStatus: { type: String, default: "pending" } },
      sms: { dltTemplateId: String, senderId: String, text: String },
      email: { subject: String, preheader: String, html: String, text: String, fromName: String },
    },
    channelOrder: { type: [String], default: [] }, // fallbacks for transactional sends
    locales: { type: Mixed, default: {} }, // { hi: { push: {...}, inapp: {...} } }
    isActive: { type: Boolean, default: true },
    updatedBy: { userId: String, name: String },
  },
  { timestamps: true, minimize: false },
);
templateSchema.index({ key: 1, version: -1 }, { unique: true });
export const NotificationTemplate = mongoose.model("NotificationTemplate", templateSchema);

// The in-app inbox (Notifications screen).
const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    category: { type: String, enum: INBOX_CATEGORIES, default: "account" },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    icon: { type: String, default: null },
    iconColor: { type: String, default: null },
    imageUrl: { type: String, default: null },
    deepLink: { screen: String, params: Mixed, url: String },
    messageId: { type: String, default: null },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });
export const Notification = mongoose.model("Notification", notificationSchema);

const deviceSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true },
    deviceId: { type: String, required: true },
    fcmToken: { type: String, default: null },
    platform: { type: String, enum: ["android", "ios", "web"], default: "android" },
    appVersion: { type: String, default: null },
    osVersion: { type: String, default: null },
    isValid: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
deviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });
deviceSchema.index({ fcmToken: 1 }, { sparse: true });
export const DeviceToken = mongoose.model("DeviceToken", deviceSchema);

// One row per message per channel: delivery log, campaign stats and attribution.
const messageLogSchema = new mongoose.Schema(
  {
    messageId: { type: String, required: true },
    user: { type: ObjectId, ref: "User", default: null },
    channel: { type: String, enum: CHANNELS, required: true },
    templateKey: { type: String, required: true },
    templateVersion: { type: Number, default: null },
    category: { type: String, enum: ["transactional", "marketing"], default: "transactional" },
    campaign: { type: ObjectId, ref: "Campaign", default: null },
    campaignRun: { type: Number, default: null },
    variant: { type: String, default: null },
    journey: { type: ObjectId, ref: "Journey", default: null },
    dedupeKey: { type: String, default: undefined },
    to: { type: String, default: null },
    rendered: { title: String, body: String },
    // queued → sent → delivered → opened/read → clicked; or suppressed / failed.
    status: { type: String, enum: ["queued", "sent", "delivered", "opened", "clicked", "failed", "suppressed"], default: "queued" },
    suppressedReason: { type: String, default: null },
    providerMessageId: { type: String, default: null },
    error: { type: String, default: null },
    sentAt: Date,
    deliveredAt: Date,
    openedAt: Date,
    clickedAt: Date,
    convertedAt: Date,
    conversionValuePaise: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
messageLogSchema.index({ messageId: 1, channel: 1 });
messageLogSchema.index({ dedupeKey: 1, channel: 1 }, { unique: true, sparse: true });
messageLogSchema.index({ user: 1, createdAt: -1 });
messageLogSchema.index({ campaign: 1, status: 1 });
messageLogSchema.index({ journey: 1, status: 1 });
messageLogSchema.index({ user: 1, category: 1, channel: 1, createdAt: -1 });
messageLogSchema.index({ providerMessageId: 1 }, { sparse: true });
messageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });
export const MessageLog = mongoose.model("MessageLog", messageLogSchema);

// Global suppression list: bounced/complained emails, DND numbers, STOP keywords.
const suppressionSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: CHANNELS, required: true },
    address: { type: String, required: true },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
suppressionSchema.index({ channel: 1, address: 1 }, { unique: true });
export const Suppression = mongoose.model("Suppression", suppressionSchema);
