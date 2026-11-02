// Broadcasts: a free-text notification (title, body, picture, link) to many people at once,
// now or at a set time, to everyone, a segment, ad-hoc rules or a pasted list. Built on the
// campaign engine, so it is throttled, resumable, approved like campaigns and has stats.
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import * as campaigns from "../engagement/campaign.service.js";
import { compileRules, Segment, validateRules } from "../engagement/segment.service.js";
import { UserStats } from "../engagement/traits.service.js";
import { User } from "../user/user.model.js";
import { mediaHosts, notify } from "./notification.service.js";
import { cleanPhones, mediaUrlProblem, placeholders, PERSONAL_VARIABLES } from "./personalize.js";

const CHANNELS = ["inapp", "push", "whatsapp", "sms", "email"];
const MAX_DAYS_AHEAD = 90;
const KNOWN_VARIABLES = new Set([...PERSONAL_VARIABLES.map((item) => item.key), "couponCode"]);

// ------------------------------------------------------------------ content

/** Checks a free-text message; returns it trimmed. Throws 422 with every problem found. */
export function checkContent(content = {}, hosts = mediaHosts()) {
  const errors = [];
  const title = String(content.title || "").trim();
  const body = String(content.body || "").trim();
  if (title.length < 2 || title.length > 80) errors.push({ field: "content.title", message: "Title is 2 to 80 characters" });
  if (body.length < 2 || body.length > 500) errors.push({ field: "content.body", message: "Message is 2 to 500 characters" });
  const unknown = [...placeholders([title, body])].filter((path) => !KNOWN_VARIABLES.has(path));
  if (unknown.length) errors.push({ field: "content.body", message: `Unknown variable ${unknown.map((path) => `{{${path}}}`).join(", ")}` });
  const imageProblem = mediaUrlProblem(content.imageUrl, hosts);
  if (imageProblem) errors.push({ field: "content.imageUrl", message: imageProblem });
  const deepLink = String(content.deepLink || "").trim();
  if (deepLink && !deepLink.startsWith("mealji://")) {
    let host = null;
    try {
      const url = new URL(deepLink);
      host = url.protocol === "https:" ? url.hostname.toLowerCase() : null;
    } catch {
      // not a URL
    }
    if (!host || !hosts.includes(host)) errors.push({ field: "content.deepLink", message: "Link must be an app link (mealji://…) or a MealJi web page" });
  }
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  return { title, body, imageUrl: content.imageUrl ? String(content.imageUrl).trim() : "", deepLink };
}

// ------------------------------------------------------------------ audience

/**
 * Who gets it. `{ type: "all" }`, `{ type: "segment", segmentId }`,
 * `{ type: "rules", rules }` (segment rules, not saved), `{ type: "users", userIds }`
 * or `{ type: "phones", phones | csv }` (10-digit numbers, pasted or as a list).
 */
export async function resolveAudience(spec = {}) {
  const type = spec.type || "segment";
  if (type === "all") return { audience: "all" };
  if (type === "segment") {
    const segment = await Segment.findById(objectId(spec.segmentId, "segment ID")).select("name isArchived").lean();
    if (!segment || segment.isArchived) throw new AppError(404, "Segment not found");
    return { audience: "segment", segmentId: String(spec.segmentId), segmentName: segment.name };
  }
  if (type === "rules") {
    validateRules(spec.rules);
    return { audience: "rules", rules: spec.rules };
  }
  if (type === "users") {
    const ids = [...new Set((spec.userIds || []).map(String))];
    if (!ids.length) throw new AppError(422, "Add at least one person");
    if (ids.length > campaigns.MAX_LIST_AUDIENCE) throw new AppError(422, `A list holds up to ${campaigns.MAX_LIST_AUDIENCE.toLocaleString("en-IN")} people`);
    const found = await User.find({ _id: { $in: ids.map((id) => objectId(id, "user ID")) }, deletedAt: null }).select("_id").lean();
    return { audience: "users", userIds: found.map((user) => String(user._id)), unmatched: ids.length - found.length };
  }
  if (type === "phones") {
    const phones = cleanPhones(spec.phones || spec.csv || []);
    if (!phones.length) throw new AppError(422, "No 10-digit mobile numbers found");
    if (phones.length > campaigns.MAX_LIST_AUDIENCE) throw new AppError(422, `A list holds up to ${campaigns.MAX_LIST_AUDIENCE.toLocaleString("en-IN")} numbers`);
    const found = [];
    for (let i = 0; i < phones.length; i += 5000) {
      found.push(...(await User.find({ phoneNumber: { $in: phones.slice(i, i + 5000) }, deletedAt: null }).select("_id").lean()));
    }
    return { audience: "users", userIds: found.map((user) => String(user._id)), unmatched: phones.length - found.length };
  }
  throw new AppError(422, "Audience type: all, segment, rules, users or phones");
}

async function statsFilter(resolved) {
  if (resolved.audience === "all") return {};
  if (resolved.audience === "rules") return compileRules(resolved.rules);
  if (resolved.audience === "users") return { user: { $in: resolved.userIds.map((id) => objectId(id, "user ID")) } };
  return { segmentIds: objectId(resolved.segmentId, "segment ID") };
}

/** How many people, and how many each channel can reach (push needs the app's token, WhatsApp an opt-in). */
export async function previewAudience(spec) {
  const resolved = await resolveAudience(spec);
  let filter = await statsFilter(resolved);
  // A static segment keeps its members on the segment, not on their stats.
  if (resolved.audience === "segment") {
    const segment = await Segment.findById(resolved.segmentId).select("type userIds").lean();
    if (segment.type === "static") filter = { user: { $in: segment.userIds } };
  }
  const [total, push, whatsapp, email, sample] = await Promise.all([
    UserStats.countDocuments(filter),
    UserStats.countDocuments({ $and: [filter, { hasPushToken: true }] }),
    UserStats.countDocuments({ $and: [filter, { whatsappOptIn: true }] }),
    UserStats.countDocuments({ $and: [filter, { emailReachable: true }] }),
    UserStats.find(filter).limit(10).populate("user", "name phoneNumber").lean(),
  ]);
  return {
    audience: resolved.audience,
    segmentName: resolved.segmentName || null,
    total,
    unmatched: resolved.unmatched || 0,
    reachable: { inapp: total, push, whatsapp, email },
    sample: sample.map((row) => ({ userId: String(row.user?._id || row.user), name: row.user?.name || null, phone: row.user?.phoneNumber ? `${row.user.phoneNumber.slice(0, 2)}••••${row.user.phoneNumber.slice(-2)}` : null, city: row.city || null })),
  };
}

// ------------------------------------------------------------------ schedule

/** `{}` or `{ type: "now" }`, `{ type: "once", sendAt }` (within 90 days), `{ type: "recurring", frequency, time, weekday?, endAt? }`. */
export function checkSchedule(schedule = {}, now = new Date()) {
  const type = schedule.type || (schedule.sendAt ? "once" : "now");
  if (type === "now") return { type: "now" };
  if (type === "once") {
    const at = new Date(schedule.sendAt);
    if (Number.isNaN(at.getTime())) throw new AppError(422, "sendAt is not a date");
    if (at.getTime() < now.getTime() + 60_000) throw new AppError(422, "Pick a time at least a minute from now");
    if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) throw new AppError(422, `Schedule up to ${MAX_DAYS_AHEAD} days ahead`);
    return { type: "once", sendAt: at };
  }
  if (type === "recurring") {
    if (!["daily", "weekly"].includes(schedule.frequency)) throw new AppError(422, "Repeat daily or weekly");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.time || ""))) throw new AppError(422, "Time is HH:mm (IST)");
    if (schedule.frequency === "weekly" && !(Number.isInteger(schedule.weekday) && schedule.weekday >= 0 && schedule.weekday <= 6)) throw new AppError(422, "Weekday is 0 (Sunday) to 6");
    const endAt = schedule.endAt ? new Date(schedule.endAt) : null;
    if (endAt && Number.isNaN(endAt.getTime())) throw new AppError(422, "endAt is not a date");
    return { type: "recurring", frequency: schedule.frequency, time: schedule.time, weekday: schedule.frequency === "weekly" ? schedule.weekday : null, endAt };
  }
  throw new AppError(422, "Schedule type: now, once or recurring");
}

// ------------------------------------------------------------------ broadcasts

function checkChannels(channels) {
  const list = channels?.length ? [...new Set(channels)] : ["inapp", "push"];
  if (list.some((channel) => !CHANNELS.includes(channel))) throw new AppError(422, `Channels: ${CHANNELS.join(", ")}`);
  return list;
}

function toBroadcast(view, extra = {}) {
  return { broadcastId: view.campaignId, ...view, ...extra };
}

/** Creates the broadcast and sends it for approval or schedules it (the campaign approval rule applies). */
export async function createBroadcast(input, actor) {
  const content = checkContent(input.content);
  const schedule = checkSchedule(input.schedule);
  const channels = checkChannels(input.channels);
  const category = input.category === "transactional" ? "transactional" : "marketing";
  const resolved = await resolveAudience(input.audience);
  if (resolved.audience === "users" && !resolved.userIds.length) throw new AppError(422, "None of these people have a MealJi account");
  const throttle = Math.max(10, Math.min(5000, Number(input.throttlePerMinute) || 1000));
  const draft = await campaigns.saveCampaign(null, {
    name: String(input.name || content.title).trim().slice(0, 100),
    kind: "broadcast",
    category,
    content,
    channels,
    audience: resolved.audience,
    segmentId: resolved.segmentId,
    rules: resolved.rules,
    userIds: resolved.userIds,
    schedule,
    // Service notices go out whatever the hour; marketing waits out quiet hours.
    sendStrategy: { throttlePerMinute: throttle, respectQuietHours: category === "marketing" && input.respectQuietHours !== false, sto: false },
    couponCode: input.couponCode || null,
  }, actor);
  const view = await campaigns.submit(draft.campaignId, actor);
  return toBroadcast(view, { unmatched: resolved.unmatched || 0 });
}

async function broadcastOf(id) {
  const campaign = await campaigns.Campaign.findById(objectId(id, "broadcast ID")).select("kind").lean();
  if (!campaign || campaign.kind !== "broadcast") throw new AppError(404, "Broadcast not found");
}

export async function listBroadcasts({ status, page = 1, limit = 25 }) {
  const data = await campaigns.listCampaigns({ status, kind: "broadcast", page, limit });
  return { ...data, items: data.items.map((item) => toBroadcast(item)) };
}

/** The broadcast with its progress: pending / sent / suppressed / failed people in the latest run. */
export async function getBroadcast(id) {
  await broadcastOf(id);
  const view = await campaigns.getCampaign(id);
  const rows = await campaigns.CampaignRecipient.aggregate([{ $match: { campaign: objectId(id, "broadcast ID"), run: view.runs } }, { $group: { _id: "$status", total: { $sum: 1 } } }]);
  const progress = Object.fromEntries(["pending", "sent", "suppressed", "failed"].map((status) => [status, rows.find((row) => row._id === status)?.total || 0]));
  return toBroadcast(view, { progress });
}

/** New send time (or recurrence) for a broadcast that has not started; it goes through approval again if needed. */
export async function reschedule(id, schedule, actor) {
  await broadcastOf(id);
  const current = await campaigns.Campaign.findById(id).select("status").lean();
  if (!["draft", "scheduled", "pending_approval", "paused"].includes(current.status)) throw new AppError(409, `A ${current.status} broadcast cannot be rescheduled`);
  if (["pending_approval", "paused"].includes(current.status)) await campaigns.Campaign.updateOne({ _id: id }, { $set: { status: "draft" } });
  await campaigns.saveCampaign(id, { schedule: checkSchedule(schedule) }, actor);
  return toBroadcast(await campaigns.submit(id, actor));
}

export async function cancelBroadcast(id) {
  await broadcastOf(id);
  return toBroadcast(await campaigns.control(id, "cancel"));
}

/** Sends the message to the person composing it (their own name and data), straight away. */
export async function testBroadcast(input, actor) {
  const content = checkContent(input.content);
  const category = input.category === "transactional" ? "transactional" : "marketing";
  return notify({
    userId: actor.userId,
    templateKey: campaigns.adHocTemplate(category),
    data: { ...content, couponCode: input.couponCode || null },
    channels: checkChannels(input.channels),
    category: "transactional", // a test always reaches its sender
    ignoreCaps: true,
    respectQuietHours: false,
  });
}
