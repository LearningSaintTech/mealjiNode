import mongoose from "mongoose";
import { escapeRegex } from "../../common/text.util.js";
import { logger } from "../../config/logger.js";
import { AuditLog } from "./audit.model.js";

// Keeps only the fields that changed, so the log shows what actually moved.
export function changedFields(before, after) {
  if (!before || !after) return { before: before ?? null, after: after ?? null };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const from = {};
  const to = {};
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      from[key] = before[key] ?? null;
      to[key] = after[key] ?? null;
    }
  }
  return { before: from, after: to };
}

function actorFrom(req) {
  const user = req?.auth?.user;
  return {
    actorId: req?.auth?.userId || null,
    actorName: user?.name || null,
    actorRole: req?.auth?.role || null,
    ip: req?.ip || null,
    userAgent: req?.headers?.["user-agent"]?.slice(0, 200) || null,
    requestId: req?.id ? String(req.id) : null,
  };
}

/**
 * Records who changed what. Never throws: a failed audit write is logged and the
 * business action still succeeds. `req` supplies the actor; pass `actor` instead
 * from jobs (e.g. `{ actorRole: "system" }`).
 */
export async function recordAudit(req, { action, entityType, entityId, summary = "", before = null, after = null, reason = null, kitchenId = null, actor = null, diff = true, session = null }) {
  try {
    const delta = diff ? changedFields(before, after) : { before, after };
    const doc = {
      ...actorFrom(req),
      ...(actor || {}),
      action,
      entityType,
      entityId: entityId ? String(entityId) : null,
      summary: String(summary).slice(0, 300),
      before: delta.before,
      after: delta.after,
      reason,
      kitchenId: kitchenId && mongoose.isValidObjectId(kitchenId) ? kitchenId : null,
    };
    await AuditLog.create([doc], session ? { session } : {});
  } catch (err) {
    logger.error({ err: err.message, action, entityType, entityId }, "Audit log write failed");
  }
}

export async function listAuditLogs(query) {
  const page = query.page || 1;
  const limit = query.limit || 25;
  const filter = {};
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.actorId) filter.actorId = query.actorId;
  if (query.kitchenId) filter.kitchenId = query.kitchenId;
  if (query.action) filter.action = { $regex: `^${escapeRegex(query.action)}`, $options: "i" };
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);

  return {
    items: items.map((item) => ({
      id: String(item._id),
      action: item.action,
      entityType: item.entityType,
      entityId: item.entityId,
      summary: item.summary,
      before: item.before,
      after: item.after,
      reason: item.reason,
      actor: { userId: item.actorId ? String(item.actorId) : null, name: item.actorName, role: item.actorRole },
      kitchenId: item.kitchenId ? String(item.kitchenId) : null,
      ip: item.ip,
      createdAt: item.createdAt,
    })),
    page,
    limit,
    total,
  };
}
