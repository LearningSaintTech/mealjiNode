import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { escapeRegex } from "../../common/text.util.js";
import { normalizeCity } from "../settings/settings.resolver.js";
import { Coupon, CouponRedemption } from "./coupon.model.js";
import { couponLabel, evaluateCoupon } from "./coupon.rules.js";

export function toCoupon(coupon, { admin = false } = {}) {
  const view = {
    couponId: String(coupon._id),
    code: coupon.code,
    title: coupon.title,
    label: couponLabel(coupon),
    description: coupon.description || "",
    terms: coupon.terms || [],
    type: coupon.type,
    value: coupon.value,
    maxDiscountPaise: coupon.maxDiscountPaise || 0,
    minOrderPaise: coupon.minOrderPaise || 0,
    validTo: coupon.validTo ?? null,
    firstOrderOnly: Boolean(coupon.firstOrderOnly),
    paymentMethods: coupon.paymentMethods || [],
  };
  if (!admin) return view;
  return {
    ...view,
    validFrom: coupon.validFrom ?? null,
    usageLimit: coupon.usageLimit || 0,
    perUserLimit: coupon.perUserLimit ?? 1,
    cities: coupon.cities || [],
    kitchenIds: (coupon.kitchens || []).map(String),
    segmentId: coupon.segment ? String(coupon.segment) : null,
    fundedBy: coupon.fundedBy,
    kitchenId: coupon.kitchen ? String(coupon.kitchen) : null,
    approvalStatus: coupon.approvalStatus,
    isPublic: coupon.isPublic !== false,
    isActive: coupon.isActive !== false,
    usedCount: coupon.usedCount || 0,
    createdAt: coupon.createdAt,
  };
}

async function userContext(userId) {
  const { Order } = await import("../order/order.model.js");
  const [delivered, redemptions] = await Promise.all([
    Order.countDocuments({ user: userId, status: "delivered" }),
    CouponRedemption.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(String(userId)), status: { $in: ["reserved", "redeemed"] } } },
      { $group: { _id: "$coupon", total: { $sum: 1 } } },
    ]),
  ]);
  let segmentIds = [];
  try {
    segmentIds = await (await import("../engagement/segment.service.js")).segmentIdsForUser(userId);
  } catch {
    segmentIds = [];
  }
  return { delivered, redemptions: new Map(redemptions.map((row) => [String(row._id), row.total])), segmentIds };
}

/** Validates a code for a cart. Returns { coupon, result } (result.valid may be false). */
export async function checkCode(code, { userId, kitchenId, city, itemTotalPaise, paymentMethod = null }) {
  const coupon = await Coupon.findOne({ code: String(code || "").trim().toUpperCase() }).lean();
  if (!coupon) return { coupon: null, result: { valid: false, reason: "invalid", message: "This code is not valid", discountPaise: 0 } };
  const ctx = await userContext(userId);
  const result = evaluateCoupon(coupon, {
    itemTotalPaise,
    kitchenId,
    city: normalizeCity(city),
    paymentMethod,
    userDeliveredOrders: ctx.delivered,
    userRedemptions: ctx.redemptions.get(String(coupon._id)) || 0,
    segmentIds: ctx.segmentIds,
  });
  return { coupon, result };
}

/** Offers the customer can see for this cart, applicable ones first. */
export async function availableCoupons({ userId, kitchenId, city, itemTotalPaise }) {
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    isPublic: true,
    approvalStatus: "live",
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
      { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
    ],
  }).sort({ createdAt: -1 }).limit(50).lean();
  const ctx = await userContext(userId);
  return coupons.map((coupon) => {
    const result = evaluateCoupon(coupon, {
      itemTotalPaise,
      kitchenId,
      city: normalizeCity(city),
      userDeliveredOrders: ctx.delivered,
      userRedemptions: ctx.redemptions.get(String(coupon._id)) || 0,
      segmentIds: ctx.segmentIds,
      now,
    });
    // Hide offers that can never apply to this person here.
    if (["kitchen", "city", "segment", "used", "first_order", "exhausted"].includes(result.reason)) return null;
    return { ...toCoupon(coupon), applicable: result.valid, message: result.message, discountPaise: result.discountPaise, shortByPaise: result.shortByPaise || 0 };
  }).filter(Boolean).sort((a, b) => Number(b.applicable) - Number(a.applicable) || b.discountPaise - a.discountPaise);
}

/** Reserves a redemption for an order (inside the placement transaction). */
export async function reserveRedemption({ coupon, userId, orderId, discountPaise, session = null }) {
  const filter = { _id: coupon._id };
  if (coupon.usageLimit > 0) filter.usedCount = { $lt: coupon.usageLimit };
  const updated = await Coupon.updateOne(filter, { $inc: { usedCount: 1 } }, { session: session || undefined });
  if (!updated.modifiedCount) throw new AppError(409, "This offer was just used up. Remove it and try again.");
  await CouponRedemption.create([{ coupon: coupon._id, code: coupon.code, user: userId, order: orderId, discountPaise, status: "reserved" }], session ? { session } : {});
}

export async function confirmRedemption(orderId, { session = null } = {}) {
  await CouponRedemption.updateOne({ order: orderId, status: "reserved" }, { $set: { status: "redeemed" } }, { session: session || undefined });
}

export async function releaseRedemption(orderId, { session = null } = {}) {
  const redemption = await CouponRedemption.findOneAndUpdate(
    { order: orderId, status: { $in: ["reserved", "redeemed"] } },
    { $set: { status: "released" } },
    { session: session || undefined },
  );
  if (redemption) await Coupon.updateOne({ _id: redemption.coupon, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session: session || undefined });
}

// ---- admin

const COUPON_FIELDS = ["title", "description", "terms", "type", "value", "maxDiscountPaise", "minOrderPaise", "validFrom", "validTo", "usageLimit", "perUserLimit", "firstOrderOnly", "cities", "paymentMethods", "isPublic", "isActive"];

function couponData(input, { partial = false } = {}) {
  const errors = [];
  const out = {};
  for (const key of COUPON_FIELDS) if (input[key] !== undefined) out[key] = input[key];
  if (!partial || input.code !== undefined) {
    if (!/^[A-Z0-9]{3,20}$/i.test(String(input.code || ""))) errors.push({ field: "code", message: "Code: 3 to 20 letters or digits" });
    else out.code = String(input.code).toUpperCase();
  }
  if (!partial && !out.title) errors.push({ field: "title", message: "Title is required" });
  if (!partial || input.type !== undefined) {
    if (!["flat", "percent", "free_delivery"].includes(out.type)) errors.push({ field: "type", message: "Type: flat, percent or free_delivery" });
  }
  if (out.type === "percent" && (!(out.value > 0) || out.value > 100)) errors.push({ field: "value", message: "Percent must be 1 to 100" });
  if (out.type === "flat" && (!Number.isInteger(out.value) || out.value <= 0)) errors.push({ field: "value", message: "Flat discount is paise above 0" });
  for (const key of ["maxDiscountPaise", "minOrderPaise", "usageLimit", "perUserLimit"]) {
    if (out[key] !== undefined && (!Number.isInteger(out[key]) || out[key] < 0)) errors.push({ field: key, message: `${key} must be a whole number` });
  }
  for (const key of ["validFrom", "validTo"]) if (out[key]) out[key] = new Date(out[key]);
  if (out.validFrom && out.validTo && out.validFrom > out.validTo) errors.push({ field: "validTo", message: "Ends before it starts" });
  if (out.cities) out.cities = out.cities.map(normalizeCity).filter(Boolean);
  if (input.kitchenIds !== undefined) out.kitchens = (input.kitchenIds || []).map((id) => objectId(id, "kitchen ID"));
  if (input.segmentId !== undefined) out.segment = input.segmentId ? objectId(input.segmentId, "segment ID") : null;
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  return out;
}

export async function listCoupons({ q, status, kitchenId, page = 1, limit = 25 }) {
  const filter = {};
  if (q) filter.$or = [{ code: { $regex: escapeRegex(q), $options: "i" } }, { title: { $regex: escapeRegex(q), $options: "i" } }];
  if (status === "active") filter.isActive = true;
  if (status === "inactive") filter.isActive = false;
  if (status === "pending") filter.approvalStatus = "pending";
  if (kitchenId) filter.kitchen = objectId(kitchenId, "kitchen ID");
  const [items, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Coupon.countDocuments(filter),
  ]);
  return { items: items.map((item) => toCoupon(item, { admin: true })), page, limit, total };
}

export async function saveCoupon(couponId, input, { kitchenId = null, actorId = null, requireApproval = false } = {}) {
  const data = couponData(input, { partial: Boolean(couponId) });
  if (kitchenId) {
    data.fundedBy = "kitchen";
    data.kitchen = kitchenId;
    data.kitchens = [kitchenId];
    if (requireApproval) data.approvalStatus = "pending";
  }
  try {
    if (!couponId) return toCoupon(await Coupon.create({ ...data, createdBy: actorId }), { admin: true });
    const filter = { _id: objectId(couponId, "coupon ID"), ...(kitchenId ? { kitchen: kitchenId } : {}) };
    const coupon = await Coupon.findOneAndUpdate(filter, { $set: data }, { new: true });
    if (!coupon) throw new AppError(404, "Coupon not found");
    return toCoupon(coupon, { admin: true });
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "This code is already used");
    throw err;
  }
}

/** Deletes a coupon nobody has used; used coupons are switched off instead. */
export async function deleteCoupon(couponId) {
  const coupon = await Coupon.findById(objectId(couponId, "coupon ID"));
  if (!coupon) throw new AppError(404, "Coupon not found");
  if (coupon.usedCount > 0 || await CouponRedemption.exists({ coupon: coupon._id })) throw new AppError(409, "This coupon has been used; switch it off instead");
  await Coupon.deleteOne({ _id: coupon._id });
  return { couponId, deleted: true, code: coupon.code };
}

export async function reviewCoupon(couponId, approve) {
  const coupon = await Coupon.findByIdAndUpdate(objectId(couponId, "coupon ID"), { $set: { approvalStatus: approve ? "live" : "rejected" } }, { new: true });
  if (!coupon) throw new AppError(404, "Coupon not found");
  return toCoupon(coupon, { admin: true });
}

export async function couponStats(couponId) {
  const id = objectId(couponId, "coupon ID");
  const [rows] = await CouponRedemption.aggregate([
    { $match: { coupon: id, status: "redeemed" } },
    { $group: { _id: null, redemptions: { $sum: 1 }, discountPaise: { $sum: "$discountPaise" }, users: { $addToSet: "$user" }, orders: { $push: "$order" } } },
  ]);
  if (!rows) return { redemptions: 0, discountPaise: 0, uniqueUsers: 0, gmvPaise: 0 };
  const { Order } = await import("../order/order.model.js");
  const [gmv] = await Order.aggregate([{ $match: { _id: { $in: rows.orders } } }, { $group: { _id: null, total: { $sum: "$bill.grandTotalPaise" } } }]);
  return { redemptions: rows.redemptions, discountPaise: rows.discountPaise, uniqueUsers: rows.users.length, gmvPaise: gmv?.total || 0 };
}
