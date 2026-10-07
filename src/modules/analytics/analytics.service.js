import crypto from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { addIstDays, istDateKey, istDateTime } from "../../common/time.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { storeSetNx } from "../../infrastructure/redisStore.js";
import { Order } from "../order/order.model.js";
import { roleRepository } from "../role/role.repository.js";
import { User } from "../user/user.model.js";
import { AnalyticsEvent, MetricsDaily } from "./analytics.model.js";
import { validateEvent } from "./events.schema.js";

const rejected = { count: 0 };

function round(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

async function fresh(eventId) {
  try {
    return await storeSetNx(`analytics:seen:${eventId}`, "1", 48 * 3600);
  } catch {
    return true; // without Redis, accept (dedupe falls back to the warehouse)
  }
}

/**
 * POST /analytics/events: validates each event against the tracking plan,
 * enriches it with identity and context, de-duplicates by eventId and stores it.
 * Returns how many were accepted and why others were not.
 */
export async function ingest(events, { userId = null, deviceId = null, platform = null, appVersion = null }) {
  const accepted = [];
  const errors = [];
  for (const [index, event] of events.entries()) {
    const problem = validateEvent(event, { source: "client" });
    if (problem) {
      rejected.count += 1;
      if (!env.isProd) errors.push({ index, message: problem });
      continue;
    }
    const eventId = String(event.eventId || crypto.randomUUID()).slice(0, 64);
    if (!(await fresh(eventId))) continue;
    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
    // Clock skew guard: clamp to [now-7d, now+5m].
    const now = Date.now();
    const at = Number.isNaN(occurredAt.getTime()) ? new Date() : new Date(Math.min(now + 300_000, Math.max(now - 7 * 24 * 3600_000, occurredAt.getTime())));
    const props = event.properties || {};
    accepted.push({
      occurredAt: at,
      meta: { name: event.name, source: "client", platform: event.platform || platform },
      eventId,
      userId: userId ? new mongoose.Types.ObjectId(String(userId)) : null,
      anonymousId: String(event.anonymousId || deviceId || "").slice(0, 80) || null,
      sessionId: event.sessionId ? String(event.sessionId).slice(0, 80) : null,
      appVersion: event.appVersion || appVersion,
      screen: event.screen || props.screen || null,
      kitchenId: mongoose.isValidObjectId(props.kitchenId) ? props.kitchenId : null,
      city: props.city || null,
      messageId: props.messageId || event.messageId || null,
      utm: event.utm || null,
      experiment: event.experiment || null,
      properties: props,
    });
  }
  if (accepted.length) await AnalyticsEvent.insertMany(accepted, { ordered: false });
  // Opening the app from a notification counts as an open for the message.
  for (const event of accepted.filter((item) => item.meta.name === "notification_opened" && item.messageId)) {
    const { trackMessage } = await import("../notification/notification.service.js");
    await trackMessage(event.messageId, "opened").catch(() => {});
  }
  if (userId && accepted.some((item) => item.meta.name === "app_opened")) {
    await User.updateOne({ _id: userId }, { $set: { lastAppOpenAt: new Date() } }).catch(() => {});
  }
  return { accepted: accepted.length, rejected: events.length - accepted.length, errors };
}

/** Server-side events (authoritative), recorded from domain-event handlers. */
export async function recordServerEvent(name, { userId = null, kitchenId = null, properties = {}, eventId }) {
  if (!(await fresh(eventId))) return;
  await AnalyticsEvent.create({
    occurredAt: new Date(),
    meta: { name, source: "server", platform: null },
    eventId,
    userId: userId && mongoose.isValidObjectId(userId) ? userId : null,
    kitchenId: kitchenId && mongoose.isValidObjectId(kitchenId) ? kitchenId : null,
    properties,
  }).catch((err) => logger.warn({ err: err.message, name }, "Server analytics event failed"));
}

// ------------------------------------------------------------------ rollups

async function customerRoleId() {
  return (await roleRepository.findBySlug("user"))?._id;
}

/** Computes one IST day's metrics, platform-wide and per kitchen. */
export async function rollupDay(dateKey) {
  const start = istDateTime(dateKey, "00:00");
  const end = istDateTime(addIstDays(dateKey, 1), "00:00");
  const range = { $gte: start, $lt: end };
  const perKitchen = await Order.aggregate([
    { $match: { createdAt: range, status: { $nin: ["payment_pending", "payment_failed"] } } },
    {
      $group: {
        _id: "$kitchen",
        city: { $first: "$city" },
        orders: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        gmvPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.grandTotalPaise", 0] } },
        itemsPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.itemTotalPaise", 0] } },
        discountPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.discountPaise", 0] } },
        refundedPaise: { $sum: "$refundedPaise" },
        codOrders: { $sum: { $cond: [{ $eq: ["$paymentMethod", "cod"] }, 1, 0] } },
        firstOrders: { $sum: { $cond: ["$isFirstOrder", 1, 0] } },
        customers: { $addToSet: "$user" },
        acceptMs: { $avg: { $cond: [{ $and: ["$acceptedAt", "$placedAt"] }, { $subtract: ["$acceptedAt", "$placedAt"] }, null] } },
        prepMs: { $avg: { $cond: [{ $and: ["$readyAt", "$acceptedAt"] }, { $subtract: ["$readyAt", "$acceptedAt"] }, null] } },
        deliveryMs: { $avg: { $cond: [{ $and: ["$deliveredAt", "$placedAt"] }, { $subtract: ["$deliveredAt", "$placedAt"] }, null] } },
        onTime: { $sum: { $cond: [{ $and: ["$deliveredAt", "$estimatedDeliveryAt", { $lte: ["$deliveredAt", "$estimatedDeliveryAt"] }] }, 1, 0] } },
        ratingSum: { $sum: { $ifNull: ["$rating.food", 0] } },
        ratingCount: { $sum: { $cond: [{ $gt: ["$rating.food", 0] }, 1, 0] } },
      },
    },
  ]);
  const roleId = await customerRoleId();
  const [signups, activeUsers] = await Promise.all([
    roleId ? User.countDocuments({ role: roleId, createdAt: range }) : 0,
    AnalyticsEvent.distinct("userId", { occurredAt: range, "meta.name": "app_opened" }).then((ids) => ids.filter(Boolean).length).catch(() => 0),
  ]);
  const metricsOf = (row) => ({
    orders: row.orders,
    delivered: row.delivered,
    cancelled: row.cancelled,
    gmvPaise: row.gmvPaise,
    itemsPaise: row.itemsPaise,
    discountPaise: row.discountPaise,
    refundedPaise: row.refundedPaise,
    netRevenuePaise: row.gmvPaise - row.discountPaise - row.refundedPaise,
    aovPaise: row.orders - row.cancelled > 0 ? Math.round(row.gmvPaise / (row.orders - row.cancelled)) : 0,
    codOrders: row.codOrders,
    firstOrders: row.firstOrders,
    customers: row.customers.length,
    avgAcceptMinutes: round(row.acceptMs / 60_000),
    avgPrepMinutes: round(row.prepMs / 60_000),
    avgDeliveryMinutes: round(row.deliveryMs / 60_000),
    onTimeRate: row.delivered ? round(row.onTime / row.delivered) : null,
    ratingAvg: row.ratingCount ? round(row.ratingSum / row.ratingCount) : null,
    ratingCount: row.ratingCount,
  });
  const total = perKitchen.reduce((acc, row) => {
    for (const key of ["orders", "delivered", "cancelled", "gmvPaise", "itemsPaise", "discountPaise", "refundedPaise", "codOrders", "firstOrders", "onTime", "ratingSum", "ratingCount"]) acc[key] = (acc[key] || 0) + row[key];
    acc.customers = [...new Set([...(acc.customers || []), ...row.customers.map(String)])];
    acc.acceptMs = row.acceptMs ?? acc.acceptMs;
    acc.prepMs = row.prepMs ?? acc.prepMs;
    acc.deliveryMs = row.deliveryMs ?? acc.deliveryMs;
    return acc;
  }, { orders: 0, delivered: 0, cancelled: 0, gmvPaise: 0, itemsPaise: 0, discountPaise: 0, refundedPaise: 0, codOrders: 0, firstOrders: 0, onTime: 0, ratingSum: 0, ratingCount: 0, customers: [] });

  let subscriptions = {};
  try {
    subscriptions = await (await import("../subscription/subscription.service.js")).subscriptionDayMetrics(dateKey);
  } catch {
    subscriptions = {};
  }
  const ops = [
    { updateOne: { filter: { date: dateKey, kitchen: null }, update: { $set: { city: null, metrics: { ...metricsOf(total), signups, activeUsers, ...subscriptions }, computedAt: new Date() } }, upsert: true } },
    ...perKitchen.map((row) => ({ updateOne: { filter: { date: dateKey, kitchen: row._id }, update: { $set: { city: row.city, metrics: metricsOf(row), computedAt: new Date() } }, upsert: true } })),
  ];
  await MetricsDaily.bulkWrite(ops);
  return perKitchen.length + 1;
}

/** Hourly job: today and yesterday (late deliveries and refunds change yesterday). */
export async function rollupRecent() {
  const today = istDateKey();
  await rollupDay(addIstDays(today, -1));
  return rollupDay(today);
}

// ------------------------------------------------------------------ dashboards

function sumMetrics(rows) {
  const out = { orders: 0, delivered: 0, cancelled: 0, gmvPaise: 0, netRevenuePaise: 0, discountPaise: 0, refundedPaise: 0, codOrders: 0, firstOrders: 0, signups: 0, activeUsers: 0, customers: 0 };
  for (const row of rows) for (const key of Object.keys(out)) out[key] += row.metrics?.[key] || 0;
  const paid = out.orders - out.cancelled;
  out.aovPaise = paid > 0 ? Math.round(out.gmvPaise / paid) : 0;
  out.cancellationRate = out.orders ? round(out.cancelled / out.orders) : null;
  out.codShare = out.orders ? round(out.codOrders / out.orders) : null;
  return out;
}

function dateRange(from, to, maxDays = 366) {
  const toKey = to || istDateKey();
  const fromKey = from || addIstDays(toKey, -29);
  const days = Math.round((istDateTime(toKey) - istDateTime(fromKey)) / 86_400_000) + 1;
  if (days < 1 || days > maxDays) throw new AppError(422, `Choose a range of 1 to ${maxDays} days`);
  return { fromKey, toKey, days };
}

/** Executive overview: totals for the range, the previous period and a daily series. */
export async function overview({ from, to, kitchenId = null }) {
  const { fromKey, toKey, days } = dateRange(from, to);
  await rollupDay(istDateKey()).catch(() => {});
  const kitchen = kitchenId ? new mongoose.Types.ObjectId(String(kitchenId)) : null;
  const prevTo = addIstDays(fromKey, -1);
  const prevFrom = addIstDays(prevTo, -(days - 1));
  const [rows, previous] = await Promise.all([
    MetricsDaily.find({ kitchen, date: { $gte: fromKey, $lte: toKey } }).sort({ date: 1 }).lean(),
    MetricsDaily.find({ kitchen, date: { $gte: prevFrom, $lte: prevTo } }).lean(),
  ]);
  const byDate = new Map(rows.map((row) => [row.date, row.metrics]));
  const series = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addIstDays(fromKey, offset);
    const metrics = byDate.get(date) || {};
    series.push({ date, orders: metrics.orders || 0, gmvPaise: metrics.gmvPaise || 0, delivered: metrics.delivered || 0, cancelled: metrics.cancelled || 0, signups: metrics.signups || 0, activeUsers: metrics.activeUsers || 0, activeSubscribers: metrics.activeSubscribers ?? null, mrrPaise: metrics.mrrPaise ?? null });
  }
  const latest = [...rows].reverse().find((row) => row.metrics?.activeSubscribers != null)?.metrics || {};
  return {
    from: fromKey,
    to: toKey,
    totals: { ...sumMetrics(rows), activeSubscribers: latest.activeSubscribers ?? null, mrrPaise: latest.mrrPaise ?? null },
    previous: sumMetrics(previous),
    series,
  };
}

export async function kitchenLeaderboard({ from, to }) {
  const { fromKey, toKey } = dateRange(from, to);
  const rows = await MetricsDaily.aggregate([
    { $match: { kitchen: { $ne: null }, date: { $gte: fromKey, $lte: toKey } } },
    {
      $group: {
        _id: "$kitchen",
        orders: { $sum: "$metrics.orders" },
        delivered: { $sum: "$metrics.delivered" },
        cancelled: { $sum: "$metrics.cancelled" },
        gmvPaise: { $sum: "$metrics.gmvPaise" },
        acceptMinutes: { $avg: "$metrics.avgAcceptMinutes" },
        prepMinutes: { $avg: "$metrics.avgPrepMinutes" },
        deliveryMinutes: { $avg: "$metrics.avgDeliveryMinutes" },
        onTimeRate: { $avg: "$metrics.onTimeRate" },
        ratingAvg: { $avg: "$metrics.ratingAvg" },
      },
    },
    { $lookup: { from: "kitchens", localField: "_id", foreignField: "_id", as: "kitchen" } },
    { $sort: { gmvPaise: -1 } },
  ]);
  return rows.map((row) => ({
    kitchenId: String(row._id),
    name: row.kitchen[0]?.name || "Kitchen",
    city: row.kitchen[0]?.city || null,
    orders: row.orders,
    delivered: row.delivered,
    cancelled: row.cancelled,
    cancellationRate: row.orders ? round(row.cancelled / row.orders) : null,
    gmvPaise: row.gmvPaise,
    avgAcceptMinutes: round(row.acceptMinutes),
    avgPrepMinutes: round(row.prepMinutes),
    avgDeliveryMinutes: round(row.deliveryMinutes),
    onTimeRate: round(row.onTimeRate),
    ratingAvg: round(row.ratingAvg),
  }));
}

/** Live ops: orders by status per kitchen right now, SLA breaches, kitchens closed during hours. */
export async function liveOps() {
  const { Kitchen } = await import("../kitchen/kitchen.model.js");
  const { isOpenAt } = await import("../kitchen/kitchen.hours.js");
  const [byStatus, breaches, kitchens] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: ["placed", "accepted", "preparing", "ready", "dispatched"] } } },
      { $group: { _id: { kitchen: "$kitchen", status: "$status" }, total: { $sum: 1 } } },
    ]),
    Order.find({ status: "placed", slaAlertedAt: { $ne: null } }).select("orderNumber kitchen kitchenName placedAt").lean(),
    Kitchen.find({ status: "active" }).lean(),
  ]);
  const map = new Map();
  for (const row of byStatus) {
    const key = String(row._id.kitchen);
    if (!map.has(key)) map.set(key, {});
    map.get(key)[row._id.status] = row.total;
  }
  return {
    kitchens: kitchens.map((kitchen) => ({
      kitchenId: String(kitchen._id),
      name: kitchen.name,
      acceptingOrders: kitchen.acceptingOrders,
      openNow: isOpenAt(kitchen),
      closedDuringHours: isOpenAt(kitchen) && !kitchen.acceptingOrders,
      orders: map.get(String(kitchen._id)) || {},
    })),
    slaBreaches: breaches.map((order) => ({ orderId: String(order._id), orderNumber: order.orderNumber, kitchenId: String(order.kitchen), kitchenName: order.kitchenName, waitingMinutes: Math.round((Date.now() - new Date(order.placedAt)) / 60_000) })),
  };
}

/** Conversion funnel from client + server events over a range. */
export async function funnel({ from, to, platform = null }) {
  const { fromKey, toKey } = dateRange(from, to, 92);
  const steps = ["app_opened", "menu_viewed", "add_to_cart", "checkout_started", "order_placed", "order_delivered"];
  const match = { occurredAt: { $gte: istDateTime(fromKey), $lt: istDateTime(addIstDays(toKey, 1)) }, "meta.name": { $in: steps } };
  if (platform) match["meta.platform"] = platform;
  const rows = await AnalyticsEvent.aggregate([
    { $match: match },
    { $group: { _id: "$meta.name", people: { $addToSet: { $ifNull: ["$userId", "$anonymousId"] } }, events: { $sum: 1 } } },
  ]);
  const byName = new Map(rows.map((row) => [row._id, { people: row.people.filter(Boolean).length, events: row.events }]));
  let previous = null;
  return {
    from: fromKey,
    to: toKey,
    steps: steps.map((name) => {
      const current = byName.get(name) || { people: 0, events: 0 };
      const conversion = previous == null ? null : previous ? round(current.people / previous) : 0;
      previous = current.people;
      return { name, ...current, conversionFromPrevious: conversion };
    }),
  };
}

/** Weekly signup cohorts × weeks since signup, by first delivered order activity. */
export async function retentionCohorts({ weeks = 8 }) {
  const roleId = await customerRoleId();
  const since = new Date(Date.now() - weeks * 7 * 86_400_000);
  const users = await User.find({ role: roleId, createdAt: { $gte: since } }).select("_id createdAt").lean();
  const weekOf = (date) => Math.floor((new Date(date) - since) / (7 * 86_400_000));
  const cohorts = new Map();
  for (const user of users) {
    const cohort = weekOf(user.createdAt);
    if (!cohorts.has(cohort)) cohorts.set(cohort, { size: 0, users: new Set() });
    cohorts.get(cohort).size += 1;
    cohorts.get(cohort).users.add(String(user._id));
  }
  const orders = await Order.find({ user: { $in: users.map((user) => user._id) }, status: "delivered" }).select("user createdAt").lean();
  const active = new Map(); // cohort -> week -> Set(users)
  const createdAt = new Map(users.map((user) => [String(user._id), user.createdAt]));
  for (const order of orders) {
    const userKey = String(order.user);
    const cohort = weekOf(createdAt.get(userKey));
    const week = Math.floor((new Date(order.createdAt) - new Date(createdAt.get(userKey))) / (7 * 86_400_000));
    if (!active.has(cohort)) active.set(cohort, new Map());
    if (!active.get(cohort).has(week)) active.get(cohort).set(week, new Set());
    active.get(cohort).get(week).add(userKey);
  }
  return [...cohorts.entries()].sort((a, b) => a[0] - b[0]).map(([cohort, data]) => ({
    weekStarting: istDateKey(new Date(since.getTime() + cohort * 7 * 86_400_000)),
    size: data.size,
    retention: Array.from({ length: weeks - cohort }, (_, week) => {
      const count = active.get(cohort)?.get(week)?.size || 0;
      return { week, users: count, rate: data.size ? round(count / data.size) : 0 };
    }),
  }));
}

export function rejectedCount() {
  return rejected.count;
}

/**
 * Warehouse feed (Phase 4): writes yesterday's raw events and orders as NDJSON
 * files (local "warehouse/" folder, or S3 when configured) for BigQuery /
 * ClickHouse loaders. Cloud-agnostic until hosting is chosen.
 */
export async function exportWarehouseDay(dateKey = addIstDays(istDateKey(), -1)) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { rootDir } = await import("../../config/env.js");
  const start = istDateTime(dateKey);
  const end = istDateTime(addIstDays(dateKey, 1));
  const lines = { events: [], orders: [] };
  for await (const row of AnalyticsEvent.find({ occurredAt: { $gte: start, $lt: end } }).lean().cursor()) lines.events.push(JSON.stringify({ ...row, name: row.meta?.name, source: row.meta?.source }));
  for await (const row of Order.find({ createdAt: { $gte: start, $lt: end } }).select("-customer.phone -address.phone").lean().cursor()) lines.orders.push(JSON.stringify(row));
  const written = {};
  for (const [table, rows] of Object.entries(lines)) {
    const body = rows.join("\n");
    const key = `warehouse/${table}/dt=${dateKey}/part-0000.ndjson`;
    if (env.storageDriver === "s3") {
      const { presignS3Put } = await import("../../infrastructure/awsSigV4.js");
      const axios = (await import("axios")).default;
      await axios.put(presignS3Put({ key, contentType: "application/x-ndjson" }), body, { headers: { "Content-Type": "application/x-ndjson" } });
    } else {
      const file = path.join(rootDir, ...key.split("/"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body, "utf8");
    }
    written[table] = rows.length;
  }
  return written;
}
