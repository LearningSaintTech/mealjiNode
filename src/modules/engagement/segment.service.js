import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { storeGetOptional, storeIncr, storeSet } from "../../infrastructure/redisStore.js";
import { TRAIT_FIELDS, UserStats } from "./traits.service.js";

const { ObjectId } = mongoose.Schema.Types;

const segmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 300 },
    type: { type: String, enum: ["dynamic", "static"], default: "dynamic" },
    rules: { type: mongoose.Schema.Types.Mixed, default: null },
    userIds: { type: [ObjectId], default: [] }, // static segments
    estimatedSize: { type: Number, default: 0 },
    lastComputedAt: { type: Date, default: null },
    isArchived: { type: Boolean, default: false },
    createdBy: { userId: String, name: String },
  },
  { timestamps: true, minimize: false },
);
export const Segment = mongoose.model("Segment", segmentSchema);

const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "nin", "exists", "contains", "olderThanDays", "withinDays"];

// ------------------------------------------------------------------ compiler

function validateRules(node, path = "rules", depth = 0) {
  if (depth > 4) throw new AppError(422, "Rules are nested too deeply");
  if (!node || typeof node !== "object") throw new AppError(422, `${path} must be an object`);
  if (node.conditions) {
    if (!["all", "any"].includes(node.op || "all")) throw new AppError(422, `${path}.op must be all or any`);
    if (!Array.isArray(node.conditions) || !node.conditions.length || node.conditions.length > 30) throw new AppError(422, `${path}.conditions must have 1 to 30 items`);
    node.conditions.forEach((child, index) => validateRules(child, `${path}.conditions[${index}]`, depth + 1));
    return;
  }
  if (node.behavior) {
    const behavior = node.behavior;
    if (typeof behavior.event !== "string" || !behavior.event) throw new AppError(422, `${path}.behavior.event is required`);
    if (!Number.isInteger(behavior.withinDays) || behavior.withinDays < 1 || behavior.withinDays > 400) throw new AppError(422, `${path}.behavior.withinDays must be 1-400`);
    return;
  }
  if (!TRAIT_FIELDS[node.field]) throw new AppError(422, `${path}.field "${node.field}" is not a trait`);
  if (!OPERATORS.includes(node.operator)) throw new AppError(422, `${path}.operator must be one of ${OPERATORS.join(", ")}`);
}

/** Users who did (or did not) an analytics event in the window, with optional property match. */
async function behaviorUsers(behavior) {
  const { AnalyticsEvent } = await import("../analytics/analytics.model.js");
  const match = { "meta.name": behavior.event, occurredAt: { $gte: new Date(Date.now() - behavior.withinDays * 86_400_000) }, userId: { $ne: null } };
  for (const [key, value] of Object.entries(behavior.where || {})) match[`properties.${key}`] = value;
  const rows = await AnalyticsEvent.aggregate([{ $match: match }, { $group: { _id: "$userId", n: { $sum: 1 } } }, { $match: { n: { $gte: behavior.minCount || 1 } } }]);
  return rows.map((row) => row._id);
}

function conditionFilter(node) {
  const { field, operator, value } = node;
  const day = 86_400_000;
  switch (operator) {
    case "eq": return { [field]: value };
    case "neq": return { [field]: { $ne: value } };
    case "gt": return { [field]: { $gt: value } };
    case "gte": return { [field]: { $gte: value } };
    case "lt": return { [field]: { $lt: value } };
    case "lte": return { [field]: { $lte: value } };
    case "between": return { [field]: { $gte: value?.[0], $lte: value?.[1] } };
    case "in": return { [field]: { $in: Array.isArray(value) ? value : [value] } };
    case "nin": return { [field]: { $nin: Array.isArray(value) ? value : [value] } };
    case "exists": return value ? { [field]: { $ne: null } } : { $or: [{ [field]: null }, { [field]: { $exists: false } }] };
    case "contains": return { [field]: value };
    case "olderThanDays": return { [field]: { $lt: new Date(Date.now() - Number(value) * day) } };
    case "withinDays": return { [field]: { $gte: new Date(Date.now() - Number(value) * day) } };
    default: throw new AppError(422, `Unknown operator ${operator}`);
  }
}

/** Compiles rule JSON to a MongoDB filter over UserStats (behavioural parts resolved first). */
export async function compileRules(node) {
  if (node.conditions) {
    const parts = await Promise.all(node.conditions.map(compileRules));
    return { [(node.op || "all") === "any" ? "$or" : "$and"]: parts };
  }
  if (node.behavior) {
    const users = await behaviorUsers(node.behavior);
    return node.behavior.did === false ? { user: { $nin: users } } : { user: { $in: users } };
  }
  return conditionFilter(node);
}

async function filterFor(segment) {
  if (segment.type === "static") return { user: { $in: segment.userIds } };
  return compileRules(segment.rules);
}

// ------------------------------------------------------------------ API

export function toSegment(segment) {
  return {
    segmentId: String(segment._id),
    name: segment.name,
    description: segment.description,
    type: segment.type,
    rules: segment.rules,
    staticCount: segment.type === "static" ? segment.userIds.length : null,
    estimatedSize: segment.estimatedSize,
    lastComputedAt: segment.lastComputedAt,
    isArchived: segment.isArchived,
    createdBy: segment.createdBy,
    updatedAt: segment.updatedAt,
  };
}

/** Count + a sample of 20 people for rules (before saving) or a saved segment. */
export async function preview({ rules = null, segmentId = null }) {
  let filter;
  if (segmentId) filter = await filterFor(await Segment.findById(objectId(segmentId, "segment ID")).lean());
  else {
    validateRules(rules);
    filter = await compileRules(rules);
  }
  const [count, sample] = await Promise.all([
    UserStats.countDocuments(filter),
    UserStats.find(filter).limit(20).populate("user", "name phoneNumber").lean(),
  ]);
  return { count, sample: sample.map((row) => ({ userId: String(row.user?._id || row.user), name: row.user?.name || null, phone: row.user?.phoneNumber ? `${row.user.phoneNumber.slice(0, 2)}••••${row.user.phoneNumber.slice(-2)}` : null, deliveredOrders: row.deliveredOrdersCount, lastOrderAt: row.lastOrderAt, city: row.city })) };
}

export async function saveSegment(segmentId, input, actor) {
  const data = {};
  if (input.name !== undefined) data.name = String(input.name).trim().slice(0, 80);
  if (input.description !== undefined) data.description = String(input.description || "").slice(0, 300);
  if (input.rules !== undefined) {
    if (segmentId && (await Segment.findById(objectId(segmentId, "segment ID")).select("type").lean())?.type === "static") {
      throw new AppError(409, "Static segments are lists of people; create a new segment for rules");
    }
    validateRules(input.rules);
    data.rules = input.rules;
    data.type = "dynamic";
  }
  if (input.isArchived !== undefined) data.isArchived = Boolean(input.isArchived);
  if (!segmentId && !data.name) throw new AppError(422, "Name is required");
  const segment = segmentId
    ? await Segment.findByIdAndUpdate(objectId(segmentId, "segment ID"), { $set: data }, { new: true })
    : await Segment.create({ ...data, type: input.rules ? "dynamic" : "static", createdBy: actor });
  if (!segment) throw new AppError(404, "Segment not found");
  segment.estimatedSize = await UserStats.countDocuments(await filterFor(segment));
  segment.lastComputedAt = new Date();
  await segment.save();
  await bumpVersion();
  return toSegment(segment);
}

/** Static segment from phone numbers or user IDs (CSV import). */
export async function importStatic(segmentId, { phones = [], userIds = [], mode = "replace" }) {
  const segment = await Segment.findById(objectId(segmentId, "segment ID"));
  if (!segment) throw new AppError(404, "Segment not found");
  if (segment.type !== "static") throw new AppError(409, "Only static segments take imports");
  const { User } = await import("../user/user.model.js");
  const cleanPhones = [...new Set(phones.map((phone) => String(phone).replace(/\D/g, "").slice(-10)).filter((phone) => phone.length === 10))];
  const byPhone = await User.find({ phoneNumber: { $in: cleanPhones }, deletedAt: null }).select("_id").lean();
  const ids = [...byPhone.map((user) => String(user._id)), ...userIds.filter((id) => mongoose.isValidObjectId(id))];
  const merged = mode === "append" ? [...new Set([...segment.userIds.map(String), ...ids])] : [...new Set(ids)];
  segment.userIds = merged.slice(0, 200_000);
  segment.estimatedSize = segment.userIds.length;
  segment.lastComputedAt = new Date();
  await segment.save();
  await bumpVersion();
  return { ...toSegment(segment), matched: ids.length, unmatchedPhones: cleanPhones.length - byPhone.length };
}

/** All user IDs in a segment (campaign snapshot). Streams in batches. */
export async function* segmentUserIds(segmentId, { batch = 1000 } = {}) {
  const segment = await Segment.findById(objectId(segmentId, "segment ID")).lean();
  if (!segment) throw new AppError(404, "Segment not found");
  if (segment.type === "static") {
    for (let i = 0; i < segment.userIds.length; i += batch) yield segment.userIds.slice(i, i + batch).map(String);
    return;
  }
  const filter = await compileRules(segment.rules);
  let buffer = [];
  for await (const row of UserStats.find(filter).select("user").lean().cursor()) {
    buffer.push(String(row.user));
    if (buffer.length >= batch) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length) yield buffer;
}

/** Segment IDs a user belongs to (banner/coupon/in-app targeting), cached 10 minutes. */
async function segmentsVersion() {
  const cached = await storeGetOptional("segments:version");
  return cached.ok && cached.value ? cached.value : "0";
}

// Any segment change bumps the version, so cached memberships are not reused.
async function bumpVersion() {
  await storeIncr("segments:version", 30 * 86_400).catch(() => {});
}

export async function segmentIdsForUser(userId) {
  const key = `segments:user:${await segmentsVersion()}:${userId}`;
  const cached = await storeGetOptional(key);
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const segments = await Segment.find({ isArchived: false }).lean();
  const ids = [];
  for (const segment of segments) {
    if (segment.type === "static") {
      if (segment.userIds.some((id) => String(id) === String(userId))) ids.push(String(segment._id));
      continue;
    }
    try {
      const filter = await compileRules(segment.rules);
      if (await UserStats.exists({ $and: [filter, { user: new mongoose.Types.ObjectId(String(userId)) }] })) ids.push(String(segment._id));
    } catch {
      // A broken rule never blocks the user's screens.
    }
  }
  await storeSet(key, JSON.stringify(ids), 600).catch(() => {});
  return ids;
}

export async function refreshSegmentSizes() {
  for (const segment of await Segment.find({ isArchived: false })) {
    try {
      segment.estimatedSize = await UserStats.countDocuments(await filterFor(segment));
      segment.lastComputedAt = new Date();
      await segment.save();
    } catch {
      // keep the previous size
    }
  }
}

export async function getSegment(segmentId) {
  const segment = await Segment.findById(objectId(segmentId, "segment ID")).lean();
  if (!segment) throw new AppError(404, "Segment not found");
  return toSegment(segment);
}

export async function listSegments() {
  return (await Segment.find().sort({ isArchived: 1, updatedAt: -1 }).lean()).map(toSegment);
}

export function traitCatalog() {
  return Object.entries(TRAIT_FIELDS).map(([field, type]) => ({ field, type }));
}
