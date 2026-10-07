import mongoose from "mongoose";

// Raw product events in a MongoDB time-series collection (13 months), the
// source for funnels, behavioural segments and the warehouse stream.
const analyticsEventSchema = new mongoose.Schema(
  {
    occurredAt: { type: Date, required: true },
    meta: {
      name: { type: String, required: true },
      source: { type: String, enum: ["client", "server"], default: "client" },
      platform: { type: String, default: null },
    },
    eventId: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    anonymousId: { type: String, default: null },
    sessionId: { type: String, default: null },
    appVersion: { type: String, default: null },
    screen: { type: String, default: null },
    kitchenId: { type: mongoose.Schema.Types.ObjectId, default: null },
    city: { type: String, default: null },
    messageId: { type: String, default: null },
    utm: { type: mongoose.Schema.Types.Mixed, default: null },
    experiment: { type: mongoose.Schema.Types.Mixed, default: null },
    properties: { type: mongoose.Schema.Types.Mixed, default: {} },
    receivedAt: { type: Date, default: Date.now },
  },
  {
    timeseries: { timeField: "occurredAt", metaField: "meta", granularity: "minutes" },
    expireAfterSeconds: 400 * 24 * 3600,
    versionKey: false,
  },
);
analyticsEventSchema.index({ "meta.name": 1, occurredAt: -1 });
analyticsEventSchema.index({ userId: 1, occurredAt: -1 });
export const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema);

// Daily rollups per kitchen (kitchenId null = platform-wide), read by dashboards.
const metricsDailySchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // IST YYYY-MM-DD
    kitchen: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", default: null },
    city: { type: String, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    computedAt: { type: Date, default: Date.now },
  },
  { minimize: false, versionKey: false },
);
metricsDailySchema.index({ date: 1, kitchen: 1 }, { unique: true });
export const MetricsDaily = mongoose.model("MetricsDaily", metricsDailySchema);
