import crypto from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { isWithinIstWindow } from "../../common/time.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { publish } from "../../realtime/hub.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { sendEmail, sendPush, sendSms, sendWhatsapp } from "./channels.js";
import { DeviceToken, MessageLog, Notification, NotificationTemplate, Suppression } from "./notification.model.js";
import { DEFAULT_TEMPLATES } from "./templates.defaults.js";

// ------------------------------------------------------------------ templates

/** Fills {{a.b}} placeholders from data; unknown paths render empty. */
export function render(text, data = {}) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path) => {
    const value = path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
    return value == null ? "" : String(value);
  }).replace(/\s+([.,!])/g, "$1").trim();
}

function renderChannel(content, data) {
  if (!content) return null;
  return Object.fromEntries(Object.entries(content).map(([key, value]) => [key, Array.isArray(value) ? value : render(value, data)]));
}

/** The template in force for a key: latest active saved version, else the code default. */
export async function getTemplate(key, { version = null } = {}) {
  const filter = { key, isActive: true, ...(version ? { version } : {}) };
  const saved = await NotificationTemplate.findOne(filter).sort({ version: -1 }).lean();
  if (saved) return { ...saved, source: "saved" };
  const fallback = DEFAULT_TEMPLATES[key];
  if (!fallback) return null;
  return { key, version: 0, name: key, ...fallback, isActive: true, source: "default" };
}

export async function listTemplates() {
  const saved = await NotificationTemplate.aggregate([{ $sort: { version: -1 } }, { $group: { _id: "$key", doc: { $first: "$$ROOT" } } }]);
  const byKey = new Map(saved.map((row) => [row._id, row.doc]));
  const keys = new Set([...Object.keys(DEFAULT_TEMPLATES), ...byKey.keys()]);
  return [...keys].sort().map((key) => {
    const doc = byKey.get(key);
    const view = doc || { key, version: 0, ...DEFAULT_TEMPLATES[key], isActive: true };
    return { key, version: view.version, name: view.name || key, category: view.category, inboxCategory: view.inboxCategory, channels: Object.keys(view.channels || {}).filter((channel) => view.channels[channel] && Object.values(view.channels[channel]).some(Boolean)), isActive: view.isActive !== false, source: doc ? "saved" : "default", updatedAt: doc?.updatedAt || null };
  });
}

export async function saveTemplate(key, input, actor) {
  if (!/^[a-z0-9_.]{3,60}$/.test(key)) throw new AppError(422, "Key: 3-60 lowercase letters, digits, dots or _");
  const current = await NotificationTemplate.findOne({ key }).sort({ version: -1 }).lean();
  const base = current || DEFAULT_TEMPLATES[key] || {};
  const next = {
    key,
    version: (current?.version || 0) + 1,
    name: input.name ?? base.name ?? key,
    category: input.category ?? base.category ?? "marketing",
    inboxCategory: input.inboxCategory ?? base.inboxCategory ?? "offers",
    channels: input.channels ?? base.channels ?? {},
    channelOrder: input.channelOrder ?? base.channelOrder ?? [],
    locales: input.locales ?? base.locales ?? {},
    isActive: input.isActive ?? true,
    updatedBy: { userId: actor?.userId || null, name: actor?.name || null },
  };
  if (next.channels.whatsapp?.providerTemplateName && current?.channels?.whatsapp?.providerTemplateName !== next.channels.whatsapp.providerTemplateName) {
    next.channels.whatsapp.approvalStatus = "pending";
  }
  const doc = await NotificationTemplate.create(next);
  return doc.toObject();
}

// ------------------------------------------------------------------ orchestrator

function firstName(name) {
  return name && name !== "User" ? name.split(" ")[0] : "there";
}

async function isSuppressed(channel, address) {
  if (!address) return false;
  return Boolean(await Suppression.exists({ channel, address: String(address).toLowerCase() }));
}

/**
 * Marketing guard rails: consent per channel, the offers topic, quiet hours and
 * per-channel frequency caps. Transactional messages skip all of this.
 */
async function marketingBlock(user, channel, policy, { respectQuietHours = true, ignoreCaps = false } = {}) {
  const prefs = user.preferences || {};
  if (prefs.channels && prefs.channels[channel] === false) return "no_consent";
  if (channel === "whatsapp" && prefs.channels?.whatsapp !== true) return "no_consent";
  if (prefs.topics?.offers === false) return "topic_off";
  const now = new Date();
  if (respectQuietHours && channel !== "inapp" && isWithinIstWindow(now, policy.quietStart, policy.quietEnd)) return "quiet_hours";
  if (channel === "sms" && !isWithinIstWindow(now, policy.promoSmsStart, policy.promoSmsEnd)) return "sms_window";
  if (ignoreCaps) return null;
  const caps = {
    push: [[policy.capPushPerDay, 1], [policy.capPushPerWeek, 7]],
    whatsapp: [[policy.capWhatsappPerWeek, 7]],
    email: [[policy.capEmailPerWeek, 7]],
  }[channel] || [];
  for (const [limit, days] of caps) {
    if (limit == null) continue;
    const sent = await MessageLog.countDocuments({ user: user._id, channel, category: "marketing", status: { $in: ["sent", "delivered", "opened", "clicked"] }, createdAt: { $gte: new Date(Date.now() - days * 24 * 3600_000) } });
    if (sent >= limit) return "frequency_cap";
  }
  return null;
}

async function reachable(user, channel) {
  if (channel === "push") return (await DeviceToken.find({ user: user._id, isValid: true, fcmToken: { $ne: null } }).lean()).map((device) => device.fcmToken);
  if (channel === "sms" || channel === "whatsapp") return user.phoneNumber && !(await isSuppressed(channel, user.phoneNumber)) ? [user.phoneNumber] : [];
  if (channel === "email") return user.email && !(await isSuppressed("email", user.email)) ? [user.email] : [];
  return [];
}

async function deliver(channel, content, target, ctx) {
  if (channel === "push") {
    const result = await sendPush({ token: target, title: content.title, body: content.body, imageUrl: content.imageUrl || null, data: { deepLink: content.deepLink ? `${content.deepLink}${content.deepLink.includes("?") ? "&" : "?"}mid=${ctx.messageId}` : "", mid: ctx.messageId } });
    if (result.invalidToken) await DeviceToken.updateOne({ fcmToken: target }, { $set: { isValid: false } });
    return result;
  }
  if (channel === "whatsapp") {
    if (content.approvalStatus && content.approvalStatus !== "approved" && env.isProd) return { ok: false, error: "WhatsApp template not approved", permanent: true };
    return sendWhatsapp({ phone: target, templateName: content.providerTemplateName, language: content.language, variables: (content.variables || []).map((path) => render(`{{${path}}}`, ctx.data)) });
  }
  if (channel === "sms") return sendSms({ phone: target, text: content.text, dltTemplateId: content.dltTemplateId, senderId: content.senderId });
  if (channel === "email") {
    const unsubscribeUrl = ctx.category === "marketing" ? `${env.publicBaseUrl}/u/${unsubscribeToken(ctx.userId, "email")}` : null;
    return sendEmail({ to: target, subject: content.subject, html: content.html, text: content.text, fromName: content.fromName, unsubscribeUrl });
  }
  return { ok: false, error: "Unknown channel" };
}

export function unsubscribeToken(userId, channel) {
  const payload = Buffer.from(JSON.stringify({ u: String(userId), c: channel })).toString("base64url");
  const sig = crypto.createHmac("sha256", env.storageSecret).update(payload).digest("base64url").slice(0, 22);
  return `${payload}.${sig}`;
}

export function readUnsubscribeToken(token) {
  const [payload, sig] = String(token || "").split(".");
  const expected = crypto.createHmac("sha256", env.storageSecret).update(payload || "").digest("base64url").slice(0, 22);
  if (!payload || sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Sends a message to one user. `channels` (optional) sends to exactly those
 * channels (campaigns); otherwise the inbox is written and the template's
 * external channels are tried in order until one reaches the person
 * (transactional fallback). Dedupe keys make replays harmless.
 * Returns { messageId, results: [{channel, status, reason}] }.
 */
export async function notify({ userId, templateKey, data = {}, channels = null, category = null, dedupeKey = null, campaign = null, campaignRun = null, variant = null, journey = null, templateVersion = null, respectQuietHours = true, ignoreCaps = false }) {
  const template = await getTemplate(templateKey, { version: templateVersion });
  if (!template) {
    logger.warn({ templateKey }, "Unknown notification template");
    return { messageId: null, results: [] };
  }
  const user = await User.findById(userId).lean();
  if (!user || user.deletedAt || user.suspendedAt) return { messageId: null, results: [] };
  const kind = category || template.category || "transactional";
  const locale = user.preferences?.language && template.locales?.[user.preferences.language] ? template.locales[user.preferences.language] : {};
  const ctx = { messageId: crypto.randomUUID(), userId: String(userId), category: kind, data: { ...data, user: { name: user.name, firstName: firstName(user.name), ...(data.user || {}) } } };
  const policy = kind === "marketing" ? (await resolveSetting("notification_policy")).values : null;
  const results = [];

  const log = async (channel, status, extra = {}) => {
    try {
      await MessageLog.create({
        messageId: ctx.messageId,
        user: userId,
        channel,
        templateKey,
        templateVersion: template.version || null,
        category: kind,
        campaign,
        campaignRun,
        variant,
        journey,
        dedupeKey: dedupeKey ? `${dedupeKey}` : undefined,
        status,
        sentAt: ["sent", "delivered"].includes(status) ? new Date() : undefined,
        ...extra,
      });
      return true;
    } catch (err) {
      if (err?.code === 11000) return false; // already sent for this dedupe key
      throw err;
    }
  };

  const content = (channel) => renderChannel({ ...(template.channels?.[channel] || {}), ...(locale[channel] || {}) }, ctx.data);
  const has = (channel) => template.channels?.[channel] && Object.values(template.channels[channel]).some((value) => value && (typeof value !== "object" || Object.keys(value).length));
  const wanted = channels || ["inapp", ...((template.channelOrder || []).filter((channel) => channel !== "inapp"))];

  // In-app inbox.
  if (wanted.includes("inapp") && has("inapp")) {
    const block = kind === "marketing" ? await marketingBlock(user, "inapp", policy, { respectQuietHours, ignoreCaps }) : null;
    const inapp = content("inapp");
    if (block) {
      await log("inapp", "suppressed", { suppressedReason: block });
      results.push({ channel: "inapp", status: "suppressed", reason: block });
    } else if (await log("inapp", "delivered", { rendered: { title: inapp.title, body: inapp.body }, deliveredAt: new Date() })) {
      const item = await Notification.create({
        user: userId,
        category: template.inboxCategory || "account",
        title: inapp.title,
        body: inapp.body,
        icon: inapp.icon || null,
        iconColor: inapp.iconColor || null,
        imageUrl: inapp.imageUrl || null,
        deepLink: inapp.deepLink ? { url: inapp.deepLink } : undefined,
        messageId: ctx.messageId,
      });
      publish(`user:${userId}`, "notification:new", { ...toInboxItem(item.toObject()), unreadCount: await unreadCount(userId) });
      results.push({ channel: "inapp", status: "delivered" });
    }
  }

  // External channels: all listed (campaign) or first reachable (transactional fallback).
  const external = wanted.filter((channel) => channel !== "inapp" && has(channel));
  for (const channel of external) {
    if (user.isDemo) {
      await log(channel, "suppressed", { suppressedReason: "demo_account" });
      results.push({ channel, status: "suppressed", reason: "demo_account" });
      continue;
    }
    if (kind === "marketing") {
      const block = await marketingBlock(user, channel, policy, { respectQuietHours, ignoreCaps });
      if (block) {
        await log(channel, "suppressed", { suppressedReason: block });
        results.push({ channel, status: "suppressed", reason: block });
        continue;
      }
    }
    const targets = await reachable(user, channel);
    if (!targets.length) {
      results.push({ channel, status: "unreachable" });
      continue;
    }
    const body = content(channel);
    let sent = false;
    for (const target of targets) {
      const result = await deliver(channel, body, target, ctx);
      const fresh = await log(channel, result.ok ? "sent" : "failed", { to: channel === "push" ? target.slice(0, 16) : target, rendered: { title: body.title || body.subject || body.providerTemplateName, body: body.body || body.text }, providerMessageId: result.providerMessageId || null, error: result.error || null });
      if (!fresh) {
        sent = true;
        break;
      }
      if (result.ok) sent = true;
      if (channel === "push") continue; // every device
      break;
    }
    results.push({ channel, status: sent ? "sent" : "failed" });
    if (sent && !channels) break; // fallback chain stops at the first channel that worked
  }
  if (results.some((item) => ["sent", "delivered"].includes(item.status))) {
    await publishEventSafe("notification.sent", { messageId: ctx.messageId, userId: String(userId), templateKey, category: kind, campaignId: campaign ? String(campaign) : null });
  }
  return { messageId: ctx.messageId, results };
}

// ------------------------------------------------------------------ inbox & devices

// The app draws these icons: box, moto, star, gift, crown, heart, megaphone.
const APP_ICONS = { box: "box", bag: "box", utensils: "box", moto: "moto", scooter: "moto", star: "star", gift: "gift", wallet: "gift", crown: "crown", heart: "heart", help: "heart", megaphone: "megaphone", sparkles: "megaphone", info: "megaphone" };
export const INBOX_TABS = [
  { key: "all", label: "All" },
  { key: "orders", label: "Orders" },
  { key: "offers", label: "Offers" },
  { key: "rewards", label: "Rewards" },
  { key: "account", label: "Account" },
];
const IST_MS = 330 * 60_000;
const istDay = (date) => Math.floor((new Date(date).getTime() + IST_MS) / 86_400_000);
const fmt = (options) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...options });
const TIME = fmt({ hour: "numeric", minute: "2-digit", hour12: true });
const WEEKDAY_DATE = fmt({ weekday: "short", day: "numeric", month: "short" });
const DAY_MONTH = fmt({ day: "numeric", month: "short" });
const ampm = (text) => text.replace(/\bam\b/i, "AM").replace(/\bpm\b/i, "PM");

/** Section heading on the Notifications screen: Today, Yesterday, This Week, Earlier. */
function inboxGroup(date, now = new Date()) {
  const diff = istDay(now) - istDay(date);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "This Week";
  return "Earlier";
}

/** “2m ago”, “1h ago”, “Yesterday, 5:30 PM”, “Mon, 12 Sep”, “5 Sep”. */
function inboxTime(date, now = new Date()) {
  const minutes = Math.floor((now - new Date(date)) / 60_000);
  const diff = istDay(now) - istDay(date);
  if (diff <= 0) {
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }
  if (diff === 1) return `Yesterday, ${ampm(TIME.format(new Date(date)))}`;
  // The app's style: “Mon, 12 Sep”, “5 Sep” (en-IN would print “Sept”).
  if (diff < 7) return WEEKDAY_DATE.format(new Date(date)).replace(/^(\w+)\s/, "$1, ").replace("Sept", "Sep");
  return DAY_MONTH.format(new Date(date)).replace("Sept", "Sep");
}

export function toInboxItem(item, now = new Date()) {
  return {
    notificationId: String(item._id),
    category: item.category,
    title: item.title,
    body: item.body,
    icon: APP_ICONS[item.icon] || "megaphone",
    iconColor: item.iconColor,
    group: inboxGroup(item.createdAt, now),
    timeLabel: inboxTime(item.createdAt, now),
    imageUrl: item.imageUrl,
    deepLink: item.deepLink?.url ? item.deepLink : null,
    messageId: item.messageId,
    isRead: Boolean(item.isRead),
    createdAt: item.createdAt,
  };
}

export async function unreadCount(userId) {
  return Notification.countDocuments({ user: userId, isRead: false });
}

export async function listInbox(userId, { category, page = 1, limit = 20, unread = false }) {
  const filter = { user: userId };
  if (category && category !== "all") filter.category = category;
  if (unread) filter.isRead = false;
  const [items, total, unreadByTab] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.aggregate([{ $match: { user: new mongoose.Types.ObjectId(String(userId)), isRead: false } }, { $group: { _id: "$category", n: { $sum: 1 } } }]),
  ]);
  const unreadPer = Object.fromEntries(unreadByTab.map((row) => [row._id, row.n]));
  const unreadTotal = unreadByTab.reduce((sum, row) => sum + row.n, 0);
  const now = new Date();
  return {
    items: items.map((item) => toInboxItem(item, now)),
    page,
    limit,
    total,
    hasMore: page * limit < total,
    unreadCount: unreadTotal,
    // Tabs All / Orders / Offers / Rewards / Account with their unread counts.
    tabs: INBOX_TABS.map((tab) => ({ ...tab, unreadCount: tab.key === "all" ? unreadTotal : unreadPer[tab.key] || 0 })),
  };
}

export async function markRead(userId, notificationId) {
  const item = await Notification.findOneAndUpdate({ _id: objectId(notificationId, "notification ID"), user: userId }, { $set: { isRead: true, readAt: new Date() } }, { new: true }).lean();
  if (!item) throw new AppError(404, "Notification not found");
  if (item.messageId) await trackMessage(item.messageId, "opened", { channel: "inapp" });
  return { ...toInboxItem(item), unreadCount: await unreadCount(userId) };
}

export async function markAllRead(userId) {
  await Notification.updateMany({ user: userId, isRead: false }, { $set: { isRead: true, readAt: new Date() } });
  return { unreadCount: 0 };
}

export async function registerDevice(userId, { deviceId, fcmToken, platform, appVersion, osVersion }) {
  if (fcmToken) await DeviceToken.updateMany({ fcmToken, user: { $ne: userId } }, { $set: { isValid: false } });
  await DeviceToken.updateOne(
    { user: userId, deviceId },
    { $set: { fcmToken: fcmToken || null, platform, appVersion: appVersion || null, osVersion: osVersion || null, isValid: Boolean(fcmToken), lastSeenAt: new Date() } },
    { upsert: true },
  );
  await User.updateOne({ _id: userId }, { $set: { platform, appVersion: appVersion || null, lastAppOpenAt: new Date() } });
  return { deviceId, registered: true };
}

export async function removeDevice(userId, deviceId) {
  await DeviceToken.deleteOne({ user: userId, deviceId });
  return { deviceId, removed: true };
}

// ------------------------------------------------------------------ tracking

/** Opened / clicked / delivered tracking from the app, links and provider webhooks. */
export async function trackMessage(messageId, event, { channel = null, valuePaise = 0 } = {}) {
  const field = { delivered: "deliveredAt", opened: "openedAt", clicked: "clickedAt", converted: "convertedAt" }[event];
  if (!field) return { tracked: false };
  const filter = { messageId, ...(channel ? { channel } : {}), [field]: null };
  const update = { $set: { [field]: new Date() } };
  if (event !== "converted") update.$set.status = event;
  if (event === "converted") update.$set.conversionValuePaise = valuePaise;
  const result = await MessageLog.updateMany(filter, update);
  if (result.modifiedCount) await publishEventSafe(`notification.${event}`, { messageId, channel });
  return { tracked: result.modifiedCount > 0 };
}

export async function searchMessages({ userId, phone, templateKey, campaignId, channel, status, page = 1, limit = 25 }) {
  const filter = {};
  if (userId) filter.user = objectId(userId, "user ID");
  if (phone) {
    const user = await User.findOne({ phoneNumber: String(phone).replace(/\D/g, "").slice(-10) }).select("_id").lean();
    filter.user = user?._id || new mongoose.Types.ObjectId();
  }
  if (templateKey) filter.templateKey = templateKey;
  if (campaignId) filter.campaign = objectId(campaignId, "campaign ID");
  if (channel) filter.channel = channel;
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    MessageLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("user", "name phoneNumber").lean(),
    MessageLog.countDocuments(filter),
  ]);
  return {
    items: items.map((item) => ({
      messageId: item.messageId,
      user: item.user ? { userId: String(item.user._id), name: item.user.name, phone: item.user.phoneNumber } : null,
      channel: item.channel,
      templateKey: item.templateKey,
      category: item.category,
      status: item.status,
      suppressedReason: item.suppressedReason,
      error: item.error,
      title: item.rendered?.title || null,
      body: item.rendered?.body || null,
      campaignId: item.campaign ? String(item.campaign) : null,
      createdAt: item.createdAt,
      openedAt: item.openedAt,
      clickedAt: item.clickedAt,
    })),
    page,
    limit,
    total,
  };
}

export async function suppress(channel, address, reason) {
  await Suppression.updateOne({ channel, address: String(address).toLowerCase() }, { $setOnInsert: { reason } }, { upsert: true });
}
