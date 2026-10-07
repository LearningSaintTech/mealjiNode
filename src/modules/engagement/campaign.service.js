import crypto from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { addIstDays, istDateKey, istDateTime, istParts } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { storeDel, storeSetNx } from "../../infrastructure/redisStore.js";
import { MessageLog } from "../notification/notification.model.js";
import { notify } from "../notification/notification.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Segment, segmentUserIds } from "./segment.service.js";
import { UserStats } from "./traits.service.js";

const { ObjectId } = mongoose.Schema.Types;

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 100 },
    objective: { type: String, default: null, maxlength: 200 },
    channels: { type: [String], default: ["push", "inapp"] },
    variants: { type: [{ _id: false, key: String, templateKey: String, templateVersion: Number, weight: Number }], default: [] },
    holdoutPercent: { type: Number, default: 0 },
    audience: { type: String, enum: ["all", "segment"], default: "segment" },
    segment: { type: ObjectId, ref: "Segment", default: null },
    schedule: {
      type: { type: String, enum: ["now", "once", "recurring"], default: "now" },
      sendAt: Date,
      frequency: { type: String, enum: ["daily", "weekly", null], default: null },
      time: String,
      weekday: Number,
      endAt: Date,
    },
    sendStrategy: { throttlePerMinute: { type: Number, default: 500 }, respectQuietHours: { type: Boolean, default: true }, sto: { type: Boolean, default: false } },
    goal: { event: { type: String, default: "order_placed" }, attributionWindowHours: { type: Number, default: 48 } },
    data: { type: mongoose.Schema.Types.Mixed, default: {} }, // template variables (offer text, coupon code…)
    deepLink: { type: String, default: null },
    couponCode: { type: String, default: null },
    utm: { source: { type: String, default: "mealji" }, medium: String, campaign: String },
    status: { type: String, enum: ["draft", "pending_approval", "scheduled", "running", "paused", "completed", "cancelled"], default: "draft" },
    approval: { requestedBy: { userId: String, name: String }, approvedBy: { userId: String, name: String }, approvedAt: Date, note: String },
    audienceSize: { type: Number, default: 0 },
    runs: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
    createdBy: { userId: String, name: String },
  },
  { timestamps: true, minimize: false },
);
campaignSchema.index({ status: 1, nextRunAt: 1 });
export const Campaign = mongoose.model("Campaign", campaignSchema);

const recipientSchema = new mongoose.Schema(
  {
    campaign: { type: ObjectId, ref: "Campaign", required: true },
    run: { type: Number, required: true },
    user: { type: ObjectId, ref: "User", required: true },
    variant: { type: String, required: true }, // A, B… or holdout
    status: { type: String, enum: ["pending", "sent", "suppressed", "failed", "holdout"], default: "pending" },
    sendAfter: { type: Date, default: null },
    messageId: { type: String, default: null },
    sentAt: Date,
  },
  { timestamps: false, versionKey: false },
);
recipientSchema.index({ campaign: 1, run: 1, user: 1 }, { unique: true });
recipientSchema.index({ campaign: 1, status: 1, sendAfter: 1 });
export const CampaignRecipient = mongoose.model("CampaignRecipient", recipientSchema);

// ------------------------------------------------------------------ helpers

/** Deterministic variant: same user, campaign and run → same bucket. */
export function assignVariant(userId, campaignId, run, variants, holdoutPercent) {
  const hash = crypto.createHash("sha1").update(`${campaignId}:${run}:${userId}`).digest().readUInt32BE(0) / 0xffffffff;
  if (hash < (holdoutPercent || 0) / 100) return "holdout";
  const total = variants.reduce((sum, variant) => sum + (variant.weight || 0), 0) || 1;
  const point = ((hash - (holdoutPercent || 0) / 100) / (1 - (holdoutPercent || 0) / 100)) * total;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight || 0;
    if (point <= cumulative) return variant.key;
  }
  return variants[variants.length - 1]?.key || "A";
}

function nextRecurring(schedule, after = new Date()) {
  let dateKey = istDateKey(after);
  for (let i = 0; i < 15; i += 1) {
    const at = istDateTime(dateKey, schedule.time || "18:00");
    const weekday = istParts(at).weekday;
    if (at > after && (schedule.frequency === "daily" || weekday === schedule.weekday)) return schedule.endAt && at > schedule.endAt ? null : at;
    dateKey = addIstDays(dateKey, 1);
  }
  return null;
}

/** For send-time optimisation: the next instant at the person's usual app-open hour (within 24 h). */
function stoTime(preferredHour, from = new Date()) {
  if (preferredHour == null) return from;
  const today = istDateKey(from);
  const at = istDateTime(today, `${String(preferredHour).padStart(2, "0")}:00`);
  return at > from ? at : istDateTime(addIstDays(today, 1), `${String(preferredHour).padStart(2, "0")}:00`);
}

export function toCampaign(campaign) {
  return {
    campaignId: String(campaign._id),
    name: campaign.name,
    objective: campaign.objective,
    channels: campaign.channels,
    variants: campaign.variants,
    holdoutPercent: campaign.holdoutPercent,
    audience: campaign.audience,
    segmentId: campaign.segment ? String(campaign.segment._id || campaign.segment) : null,
    segmentName: campaign.segment?.name || null,
    schedule: campaign.schedule,
    sendStrategy: campaign.sendStrategy,
    goal: campaign.goal,
    data: campaign.data,
    deepLink: campaign.deepLink,
    couponCode: campaign.couponCode,
    status: campaign.status,
    approval: campaign.approval,
    audienceSize: campaign.audienceSize,
    runs: campaign.runs,
    nextRunAt: campaign.nextRunAt,
    lastRunAt: campaign.lastRunAt,
    createdBy: campaign.createdBy,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

async function audienceSize(campaign) {
  if (campaign.audience === "all") return UserStats.countDocuments({});
  const segment = await Segment.findById(campaign.segment).lean();
  return segment?.estimatedSize || 0;
}

// ------------------------------------------------------------------ CRUD & lifecycle

const EDITABLE = ["name", "objective", "channels", "variants", "holdoutPercent", "audience", "schedule", "sendStrategy", "goal", "data", "deepLink", "couponCode", "utm"];

export async function saveCampaign(campaignId, input, actor) {
  const data = Object.fromEntries(EDITABLE.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  if (input.segmentId !== undefined) data.segment = input.segmentId ? objectId(input.segmentId, "segment ID") : null;
  if (data.channels && (!Array.isArray(data.channels) || !data.channels.length || data.channels.some((channel) => !["push", "inapp", "whatsapp", "sms", "email"].includes(channel)))) throw new AppError(422, "Channels: push, inapp, whatsapp, sms, email");
  if (data.variants) {
    if (!Array.isArray(data.variants) || !data.variants.length || data.variants.length > 4) throw new AppError(422, "1 to 4 variants");
    data.variants = data.variants.map((variant, index) => ({ key: variant.key || String.fromCharCode(65 + index), templateKey: variant.templateKey, templateVersion: variant.templateVersion || null, weight: Number(variant.weight) || 1 }));
    if (data.variants.some((variant) => !variant.templateKey)) throw new AppError(422, "Each variant needs a template");
  }
  if (data.holdoutPercent !== undefined && (data.holdoutPercent < 0 || data.holdoutPercent > 50)) throw new AppError(422, "Holdout is 0 to 50%");
  if (campaignId) {
    const campaign = await Campaign.findById(objectId(campaignId, "campaign ID"));
    if (!campaign) throw new AppError(404, "Campaign not found");
    if (!["draft", "paused", "scheduled"].includes(campaign.status)) throw new AppError(409, "Only draft, scheduled or paused campaigns can be edited");
    Object.assign(campaign, data);
    if (campaign.status === "scheduled") campaign.status = "draft"; // edits need submitting again
    await campaign.save();
    return toCampaign(campaign);
  }
  if (!data.name || !data.variants?.length) throw new AppError(422, "Name and at least one variant are required");
  if ((data.audience || "segment") === "segment" && !data.segment) throw new AppError(422, "Choose a segment");
  return toCampaign(await Campaign.create({ ...data, createdBy: actor }));
}

export async function submit(campaignId, actor) {
  const campaign = await Campaign.findById(objectId(campaignId, "campaign ID"));
  if (!campaign) throw new AppError(404, "Campaign not found");
  if (campaign.status !== "draft") throw new AppError(409, "Only drafts can be submitted");
  const { getTemplate } = await import("../notification/notification.service.js");
  for (const variant of campaign.variants) {
    const template = await getTemplate(variant.templateKey, { version: variant.templateVersion || null });
    if (!template) throw new AppError(422, `Template ${variant.templateKey} not found`);
    if (campaign.channels.includes("whatsapp") && template.channels?.whatsapp?.providerTemplateName && template.channels.whatsapp.approvalStatus !== "approved") {
      throw new AppError(409, `WhatsApp template for ${variant.templateKey} is not approved yet`);
    }
  }
  campaign.audienceSize = await audienceSize(campaign);
  const policy = (await resolveSetting("notification_policy")).values;
  const needsApproval = policy.campaignApprovalAbove === 0 || campaign.audienceSize > policy.campaignApprovalAbove;
  campaign.set("approval.requestedBy", { userId: actor.userId, name: actor.name });
  if (needsApproval) campaign.status = "pending_approval";
  else schedule(campaign);
  await campaign.save();
  return toCampaign(campaign);
}

function schedule(campaign) {
  campaign.status = "scheduled";
  const plan = campaign.schedule || {};
  campaign.nextRunAt = plan.type === "once" ? new Date(plan.sendAt) : plan.type === "recurring" ? nextRecurring(plan) : new Date();
  if (!campaign.nextRunAt) throw new AppError(422, "The schedule has no future send time");
}

export async function approve(campaignId, { approve: yes, note }, actor) {
  const campaign = await Campaign.findById(objectId(campaignId, "campaign ID"));
  if (!campaign) throw new AppError(404, "Campaign not found");
  if (campaign.status !== "pending_approval") throw new AppError(409, "This campaign is not waiting for approval");
  if (campaign.approval?.requestedBy?.userId === actor.userId && actor.role !== "superadmin") throw new AppError(403, "Someone else must approve your campaign");
  if (yes) {
    schedule(campaign);
    campaign.set("approval.approvedBy", { userId: actor.userId, name: actor.name });
    campaign.set("approval.approvedAt", new Date());
    campaign.set("approval.note", note || null);
  } else {
    campaign.status = "draft";
    campaign.set("approval.note", note || "Rejected");
  }
  await campaign.save();
  return toCampaign(campaign);
}

export async function control(campaignId, action) {
  const campaign = await Campaign.findById(objectId(campaignId, "campaign ID"));
  if (!campaign) throw new AppError(404, "Campaign not found");
  if (action === "pause" && ["scheduled", "running"].includes(campaign.status)) campaign.status = "paused";
  else if (action === "resume" && campaign.status === "paused") campaign.status = campaign.nextRunAt && campaign.nextRunAt > new Date() ? "scheduled" : "running";
  else if (action === "cancel" && !["completed", "cancelled"].includes(campaign.status)) campaign.status = "cancelled";
  else throw new AppError(409, `Cannot ${action} a ${campaign.status} campaign`);
  await campaign.save();
  return toCampaign(campaign);
}

export async function deleteDraft(campaignId) {
  const campaign = await Campaign.findOneAndDelete({ _id: objectId(campaignId, "campaign ID"), status: { $in: ["draft", "cancelled"] }, runs: 0 });
  if (!campaign) throw new AppError(409, "Only drafts that never ran can be deleted");
  return { campaignId, deleted: true };
}

export async function listCampaigns({ status, page = 1, limit = 25 }) {
  const filter = status ? { status } : {};
  const [items, total] = await Promise.all([
    Campaign.find(filter).populate("segment", "name").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Campaign.countDocuments(filter),
  ]);
  return { items: items.map(toCampaign), page, limit, total };
}

export async function getCampaign(campaignId) {
  const campaign = await Campaign.findById(objectId(campaignId, "campaign ID")).populate("segment", "name").lean();
  if (!campaign) throw new AppError(404, "Campaign not found");
  return { ...toCampaign(campaign), stats: await campaignStats(campaign._id) };
}

// ------------------------------------------------------------------ sending

async function snapshot(campaign) {
  const run = campaign.runs;
  let total = 0;
  const insert = async (userIds) => {
    const stats = campaign.sendStrategy?.sto ? new Map((await UserStats.find({ user: { $in: userIds } }).select("user preferredHour").lean()).map((row) => [String(row.user), row.preferredHour])) : null;
    const docs = userIds.map((userId) => {
      const variant = assignVariant(userId, String(campaign._id), run, campaign.variants, campaign.holdoutPercent);
      return { campaign: campaign._id, run, user: userId, variant, status: variant === "holdout" ? "holdout" : "pending", sendAfter: stats ? stoTime(stats.get(userId)) : null };
    });
    if (docs.length) await CampaignRecipient.insertMany(docs, { ordered: false }).catch((err) => { if (err?.code !== 11000 && !err?.writeErrors) throw err; });
    total += docs.length;
  };
  if (campaign.audience === "all") {
    let batch = [];
    for await (const row of UserStats.find({}).select("user").lean().cursor()) {
      batch.push(String(row.user));
      if (batch.length >= 1000) {
        await insert(batch);
        batch = [];
      }
    }
    if (batch.length) await insert(batch);
  } else {
    for await (const batch of segmentUserIds(campaign.segment)) await insert(batch);
  }
  return total;
}

async function sendPending(campaign) {
  const now = new Date();
  const limit = Math.max(1, Math.min(5000, campaign.sendStrategy?.throttlePerMinute || 500));
  const due = await CampaignRecipient.find({ campaign: campaign._id, run: campaign.runs, status: "pending", $or: [{ sendAfter: null }, { sendAfter: { $lte: now } }] }).limit(limit).lean();
  for (const recipient of due) {
    const variant = campaign.variants.find((item) => item.key === recipient.variant) || campaign.variants[0];
    try {
      const result = await notify({
        userId: recipient.user,
        templateKey: variant.templateKey,
        templateVersion: variant.templateVersion || null,
        data: { ...(campaign.data || {}), couponCode: campaign.couponCode, campaign: { name: campaign.name } },
        channels: campaign.channels,
        category: "marketing",
        dedupeKey: `campaign:${campaign._id}:run:${campaign.runs}:user:${recipient.user}`,
        campaign: campaign._id,
        campaignRun: campaign.runs,
        variant: recipient.variant,
        respectQuietHours: campaign.sendStrategy?.respectQuietHours !== false,
      });
      const sent = result.results.some((item) => ["sent", "delivered"].includes(item.status));
      await CampaignRecipient.updateOne({ _id: recipient._id }, { $set: { status: sent ? "sent" : "suppressed", messageId: result.messageId, sentAt: new Date() } });
    } catch (err) {
      await CampaignRecipient.updateOne({ _id: recipient._id }, { $set: { status: "failed" } });
      logger.warn({ err: err.message, campaignId: String(campaign._id) }, "Campaign send failed");
    }
  }
  const remaining = await CampaignRecipient.countDocuments({ campaign: campaign._id, run: campaign.runs, status: "pending" });
  return { sent: due.length, remaining };
}

/**
 * Every minute: starts due runs (snapshot the audience once per run, so a run
 * is reproducible and resumable) and sends the next throttled batch of every
 * running campaign. A Redis lock keeps one dispatcher per campaign.
 */
export async function dispatchDueCampaigns() {
  const now = new Date();
  let processed = 0;
  const starting = await Campaign.find({ status: "scheduled", nextRunAt: { $lte: now } }).limit(10);
  for (const campaign of starting) {
    campaign.status = "running";
    campaign.runs += 1;
    campaign.lastRunAt = now;
    await campaign.save();
    campaign.audienceSize = await snapshot(campaign);
    await campaign.save();
    await publishEventSafe("campaign.started", { campaignId: String(campaign._id), run: campaign.runs, audience: campaign.audienceSize });
  }
  for (const campaign of await Campaign.find({ status: "running" }).limit(20)) {
    const lock = `lock:campaign:${campaign._id}`;
    let locked = true;
    try {
      locked = await storeSetNx(lock, "1", 120);
    } catch {
      locked = true;
    }
    if (!locked) continue;
    try {
      const { remaining } = await sendPending(campaign);
      processed += 1;
      if (remaining === 0) {
        if (campaign.schedule?.type === "recurring") {
          campaign.nextRunAt = nextRecurring(campaign.schedule, new Date());
          campaign.status = campaign.nextRunAt ? "scheduled" : "completed";
        } else {
          campaign.status = "completed";
        }
        await campaign.save();
        await publishEventSafe("campaign.completed", { campaignId: String(campaign._id), run: campaign.runs });
      }
    } finally {
      await storeDel(lock).catch(() => {});
    }
  }
  return processed;
}

// ------------------------------------------------------------------ stats & attribution

export async function campaignStats(campaignId) {
  const id = new mongoose.Types.ObjectId(String(campaignId));
  const campaign = await Campaign.findById(id).lean();
  const [byVariant, recipients] = await Promise.all([
    MessageLog.aggregate([
      { $match: { campaign: id } },
      {
        $group: {
          _id: { variant: "$variant", channel: "$channel" },
          targeted: { $sum: 1 },
          suppressed: { $sum: { $cond: [{ $eq: ["$status", "suppressed"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "opened", "clicked"]] }, 1, 0] } },
          delivered: { $sum: { $cond: ["$deliveredAt", 1, 0] } },
          opened: { $sum: { $cond: ["$openedAt", 1, 0] } },
          clicked: { $sum: { $cond: ["$clickedAt", 1, 0] } },
          converted: { $sum: { $cond: ["$convertedAt", 1, 0] } },
          revenuePaise: { $sum: "$conversionValuePaise" },
        },
      },
    ]),
    CampaignRecipient.aggregate([{ $match: { campaign: id } }, { $group: { _id: { variant: "$variant", status: "$status" }, total: { $sum: 1 } } }]),
  ]);
  // Holdout lift: conversion of people kept out vs people messaged.
  let holdout = null;
  const holdoutUsers = await CampaignRecipient.find({ campaign: id, run: campaign?.runs, variant: "holdout" }).select("user").lean();
  if (holdoutUsers.length && campaign?.lastRunAt) {
    const { Order } = await import("../order/order.model.js");
    const windowEnd = new Date(campaign.lastRunAt.getTime() + (campaign.goal?.attributionWindowHours || 48) * 3600_000);
    const converted = await Order.distinct("user", { user: { $in: holdoutUsers.map((row) => row.user) }, createdAt: { $gte: campaign.lastRunAt, $lte: windowEnd }, status: { $nin: ["payment_pending", "payment_failed", "cancelled"] } });
    holdout = { size: holdoutUsers.length, converted: converted.length, rate: Math.round((converted.length / holdoutUsers.length) * 1000) / 1000 };
  }
  // Conversion rate of messaged people (any channel) in the latest run vs the holdout.
  const messaged = await CampaignRecipient.countDocuments({ campaign: id, run: campaign?.runs, status: "sent" });
  const convertedMessaged = (await MessageLog.distinct("user", { campaign: id, campaignRun: campaign?.runs, convertedAt: { $ne: null } })).length;
  return {
    variants: byVariant.map((row) => ({ variant: row._id.variant, channel: row._id.channel, ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "_id")) })),
    recipients: recipients.map((row) => ({ variant: row._id.variant, status: row._id.status, total: row.total })),
    holdout,
    lift: holdout && messaged ? Math.round(((convertedMessaged / messaged) - holdout.rate) * 1000) / 1000 : null,
  };
}

/** order.placed → the last marketing message that reached this person within the goal window. */
export async function attributeConversion({ userId, orderId, valuePaise }) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const message = await MessageLog.findOne({ user: userId, category: "marketing", status: { $in: ["sent", "delivered", "opened", "clicked"] }, convertedAt: null, createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
  if (!message) return null;
  let windowHours = 48;
  if (message.campaign) windowHours = (await Campaign.findById(message.campaign).select("goal").lean())?.goal?.attributionWindowHours || 48;
  if (Date.now() - new Date(message.createdAt).getTime() > windowHours * 3600_000) return null;
  await MessageLog.updateMany({ messageId: message.messageId }, { $set: { convertedAt: new Date(), conversionValuePaise: valuePaise || 0 } });
  await publishEventSafe("notification.converted", { messageId: message.messageId, campaignId: message.campaign ? String(message.campaign) : null, journeyId: message.journey ? String(message.journey) : null, orderId, userId: String(userId), valuePaise });
  return message.messageId;
}

export async function marketingDashboard({ from, to }) {
  const toKey = to || istDateKey();
  const fromKey = from || addIstDays(toKey, -29);
  const range = { $gte: istDateTime(fromKey), $lt: istDateTime(addIstDays(toKey, 1)) };
  const [channels, campaigns, journeys, unsubscribes] = await Promise.all([
    MessageLog.aggregate([
      { $match: { createdAt: range, category: "marketing" } },
      { $group: { _id: "$channel", sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "opened", "clicked"]] }, 1, 0] } }, suppressed: { $sum: { $cond: [{ $eq: ["$status", "suppressed"] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } }, opened: { $sum: { $cond: ["$openedAt", 1, 0] } }, clicked: { $sum: { $cond: ["$clickedAt", 1, 0] } }, converted: { $sum: { $cond: ["$convertedAt", 1, 0] } }, revenuePaise: { $sum: "$conversionValuePaise" } } },
    ]),
    MessageLog.aggregate([
      { $match: { createdAt: range, campaign: { $ne: null } } },
      { $group: { _id: "$campaign", sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "opened", "clicked"]] }, 1, 0] } }, opened: { $sum: { $cond: ["$openedAt", 1, 0] } }, converted: { $sum: { $cond: ["$convertedAt", 1, 0] } }, revenuePaise: { $sum: "$conversionValuePaise" } } },
      { $lookup: { from: "campaigns", localField: "_id", foreignField: "_id", as: "c" } },
      { $project: { _id: 0, campaignId: { $toString: "$_id" }, name: { $first: "$c.name" }, status: { $first: "$c.status" }, sent: 1, opened: 1, converted: 1, revenuePaise: 1 } },
      { $sort: { sent: -1 } },
      { $limit: 20 },
    ]),
    MessageLog.aggregate([
      { $match: { createdAt: range, journey: { $ne: null } } },
      { $group: { _id: "$journey", sent: { $sum: 1 }, converted: { $sum: { $cond: ["$convertedAt", 1, 0] } }, revenuePaise: { $sum: "$conversionValuePaise" } } },
      { $lookup: { from: "journeys", localField: "_id", foreignField: "_id", as: "j" } },
      { $project: { _id: 0, journeyId: { $toString: "$_id" }, name: { $first: "$j.name" }, sent: 1, converted: 1, revenuePaise: 1 } },
    ]),
    (await import("../consent/consent.model.js")).UserConsent.countDocuments({ createdAt: range, status: "revoked", purpose: "marketing" }),
  ]);
  return { from: fromKey, to: toKey, channels: channels.map((row) => ({ channel: row._id, ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "_id")) })), campaigns, journeys, unsubscribes };
}
