import crypto from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";

// A/B experiments. Assignment is deterministic: hash(userId + key) decides
// whether a person is in the experiment (allocation) and which variant they see,
// so the same person always gets the same variant without storing it.
const experimentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, match: /^[a-z0-9_]{3,40}$/ },
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "" },
    variants: { type: [{ _id: false, key: String, weight: Number, config: mongoose.Schema.Types.Mixed }], default: [] },
    allocationPercent: { type: Number, default: 100, min: 0, max: 100 },
    segment: { type: mongoose.Schema.Types.ObjectId, ref: "Segment", default: null },
    metric: { type: String, default: "order_placed" },
    windowDays: { type: Number, default: 14 },
    status: { type: String, enum: ["draft", "running", "stopped"], default: "draft" },
    winner: { type: String, default: null },
    startedAt: Date,
    stoppedAt: Date,
  },
  { timestamps: true, minimize: false },
);
export const Experiment = mongoose.model("Experiment", experimentSchema);

function bucket(userId, key, salt) {
  return crypto.createHash("sha1").update(`${salt}:${key}:${userId}`).digest().readUInt32BE(0) / 0xffffffff;
}

/** The variant a person gets, or null when outside the allocation. */
export function assign(experiment, userId) {
  if (experiment.winner) return experiment.winner;
  if (bucket(userId, experiment.key, "alloc") >= (experiment.allocationPercent ?? 100) / 100) return null;
  const total = experiment.variants.reduce((sum, variant) => sum + (variant.weight || 0), 0) || 1;
  const point = bucket(userId, experiment.key, "variant") * total;
  let cumulative = 0;
  for (const variant of experiment.variants) {
    cumulative += variant.weight || 0;
    if (point <= cumulative) return variant.key;
  }
  return experiment.variants[experiment.variants.length - 1]?.key || null;
}

async function runningExperiments() {
  const cached = await storeGetOptional("experiments:running");
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const rows = await Experiment.find({ status: { $in: ["running", "stopped"] }, $or: [{ status: "running" }, { winner: { $ne: null } }] }).lean();
  await storeSet("experiments:running", JSON.stringify(rows), 60).catch(() => {});
  return rows;
}

/** `{ key: { variant, config } }` for a person (returned in GET /app/config). */
export async function experimentsFor(userId) {
  const rows = await runningExperiments();
  let segments = null;
  const out = {};
  for (const experiment of rows) {
    if (experiment.segment) {
      segments = segments || await (await import("../engagement/segment.service.js")).segmentIdsForUser(userId);
      if (!segments.includes(String(experiment.segment))) continue;
    }
    const variant = assign(experiment, String(userId));
    if (!variant) continue;
    out[experiment.key] = { variant, config: experiment.variants.find((item) => item.key === variant)?.config || {} };
  }
  return out;
}

export async function deleteExperiment(id) {
  const row = await Experiment.findOneAndDelete({ _id: objectId(id, "experiment ID"), status: { $ne: "running" } });
  if (!row) throw new AppError(409, "Stop the experiment before deleting it");
  await storeSet("experiments:running", "", 1).catch(() => {});
  return { experimentId: id, deleted: true };
}

export function toExperiment(row) {
  return { experimentId: String(row._id), key: row.key, name: row.name, description: row.description, variants: row.variants, allocationPercent: row.allocationPercent, segmentId: row.segment ? String(row.segment) : null, metric: row.metric, windowDays: row.windowDays, status: row.status, winner: row.winner, startedAt: row.startedAt, stoppedAt: row.stoppedAt };
}

export async function saveExperiment(id, input) {
  const data = {};
  for (const key of ["name", "description", "variants", "allocationPercent", "metric", "windowDays"]) if (input[key] !== undefined) data[key] = input[key];
  if (input.segmentId !== undefined) data.segment = input.segmentId ? objectId(input.segmentId, "segment ID") : null;
  if (data.variants && (!Array.isArray(data.variants) || data.variants.length < 2 || data.variants.length > 5 || data.variants.some((variant) => !variant.key))) throw new AppError(422, "2 to 5 variants with keys");
  if (!id) {
    if (!input.key || !data.name || !data.variants) throw new AppError(422, "Key, name and variants are required");
    try {
      return toExperiment(await Experiment.create({ ...data, key: input.key }));
    } catch (err) {
      if (err?.code === 11000) throw new AppError(409, "This key is used");
      throw err;
    }
  }
  const row = await Experiment.findById(objectId(id, "experiment ID"));
  if (!row) throw new AppError(404, "Experiment not found");
  if (row.status === "running" && (data.variants || data.allocationPercent !== undefined)) throw new AppError(409, "Stop the experiment before changing variants or allocation");
  Object.assign(row, data);
  await row.save();
  await storeSet("experiments:running", "", 1).catch(() => {});
  return toExperiment(row);
}

export async function setStatus(id, { status, winner = null }) {
  const row = await Experiment.findById(objectId(id, "experiment ID"));
  if (!row) throw new AppError(404, "Experiment not found");
  if (status === "running") {
    row.startedAt = new Date();
    row.stoppedAt = null;
    row.winner = null;
  }
  if (status === "stopped") {
    row.stoppedAt = new Date();
    if (winner && !row.variants.some((variant) => variant.key === winner)) throw new AppError(422, "Winner must be one of the variants");
    row.winner = winner;
  }
  row.status = status;
  await row.save();
  await storeSet("experiments:running", "", 1).catch(() => {});
  return toExperiment(row);
}

/**
 * Results: exposed people per variant (from experiment_exposed events) and how
 * many converted (did the metric event) after exposure within the window.
 */
export async function results(id) {
  const row = await Experiment.findById(objectId(id, "experiment ID")).lean();
  if (!row) throw new AppError(404, "Experiment not found");
  const { AnalyticsEvent } = await import("../analytics/analytics.model.js");
  const since = row.startedAt || row.createdAt;
  const exposures = await AnalyticsEvent.aggregate([
    { $match: { "meta.name": "experiment_exposed", "properties.experimentKey": row.key, occurredAt: { $gte: since }, userId: { $ne: null } } },
    { $group: { _id: "$userId", variant: { $first: "$properties.variant" }, first: { $min: "$occurredAt" } } },
  ]);
  const byVariant = new Map(row.variants.map((variant) => [variant.key, { variant: variant.key, exposed: 0, converted: 0 }]));
  for (const exposure of exposures) {
    const entry = byVariant.get(exposure.variant);
    if (!entry) continue;
    entry.exposed += 1;
    const end = new Date(new Date(exposure.first).getTime() + row.windowDays * 86_400_000);
    if (await AnalyticsEvent.exists({ userId: exposure._id, "meta.name": row.metric, occurredAt: { $gte: exposure.first, $lte: end } })) entry.converted += 1;
  }
  const variants = [...byVariant.values()].map((entry) => ({ ...entry, rate: entry.exposed ? Math.round((entry.converted / entry.exposed) * 10000) / 10000 : 0 }));
  const control = variants[0];
  return {
    experiment: toExperiment(row),
    variants: variants.map((entry) => {
      if (entry === control || !control.exposed || !entry.exposed) return { ...entry, liftVsControl: null, zScore: null };
      // Two-proportion z-test against the first (control) variant.
      const pooled = (control.converted + entry.converted) / (control.exposed + entry.exposed);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / control.exposed + 1 / entry.exposed));
      return { ...entry, liftVsControl: control.rate ? Math.round(((entry.rate - control.rate) / control.rate) * 1000) / 1000 : null, zScore: se ? Math.round(((entry.rate - control.rate) / se) * 100) / 100 : null };
    }),
  };
}
