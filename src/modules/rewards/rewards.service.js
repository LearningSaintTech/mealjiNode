import crypto from "node:crypto";
import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { addIstDays, istDateKey, istParts } from "../../common/time.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { Coupon } from "../coupon/coupon.model.js";
import { DeviceToken } from "../notification/notification.model.js";
import { Order } from "../order/order.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { RewardTransaction } from "./ledger.model.js";
import { earnPoints, spendPoints, tierFor } from "./ledger.service.js";
import { Referral, Reward, RewardRedemption } from "./rewards.model.js";

async function loyalty() {
  return (await resolveSetting("loyalty")).values;
}

export function toReward(reward) {
  return {
    rewardId: String(reward._id),
    name: reward.name,
    description: reward.description,
    imageUrl: reward.imageUrl,
    points: reward.points,
    kind: reward.kind,
    value: reward.value,
    maxDiscountPaise: reward.maxDiscountPaise,
    minOrderPaise: reward.minOrderPaise,
    dishId: reward.dish ? String(reward.dish) : null,
    validDays: reward.validDays,
    stock: reward.stock || 0,
    stockLeft: reward.stock ? Math.max(0, reward.stock - (reward.redeemedCount || 0)) : null,
    tiers: reward.tiers || [],
    sortOrder: reward.sortOrder || 0,
    isActive: reward.isActive !== false,
  };
}

// ------------------------------------------------------------------ customer

export async function summary(userId) {
  const [user, settings] = await Promise.all([User.findById(userId).lean(), loyalty()]);
  const lifetime = user?.lifetimePoints || 0;
  const tier = tierFor(lifetime, settings);
  const index = settings.tierNames.indexOf(tier);
  const nextTier = settings.tierNames[index + 1] || null;
  const nextAt = nextTier ? settings.tierThresholds[index + 1] : null;
  const expiring = await RewardTransaction.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)), remaining: { $gt: 0 }, expiresAt: { $ne: null, $lte: new Date(Date.now() + 30 * 86_400_000) } } },
    { $group: { _id: null, points: { $sum: "$remaining" }, first: { $min: "$expiresAt" } } },
  ]);
  return {
    enabled: settings.enabled,
    points: user?.pointsBalance || 0,
    valuePaise: (user?.pointsBalance || 0) * settings.pointValuePaise,
    pointValuePaise: settings.pointValuePaise,
    lifetimePoints: lifetime,
    tier,
    tiers: settings.tierNames.map((name, position) => ({ name, threshold: settings.tierThresholds[position] ?? null, current: name === tier })),
    nextTier: nextTier ? { name: nextTier, pointsNeeded: Math.max(0, nextAt - lifetime) } : null,
    expiringSoon: expiring[0] ? { points: expiring[0].points, from: expiring[0].first } : null,
  };
}

export async function earnMethods() {
  const settings = await loyalty();
  return [
    { key: "order", title: "Order a meal", points: settings.pointsPerOrder, description: "Every delivered order" },
    { key: "review", title: "Rate your order", points: settings.pointsPerReview, description: "Once per delivered order" },
    { key: "referral", title: "Refer a friend", points: settings.pointsReferral, description: settings.referralRequiresDelivery ? "When their first order is delivered" : "When they sign up" },
    { key: "birthday", title: "Birthday treat", points: settings.pointsBirthday, description: "Add your birthday to your profile" },
  ].filter((item) => item.points > 0);
}

export async function catalog(userId) {
  const [rewards, user] = await Promise.all([Reward.find({ isActive: true }).sort({ sortOrder: 1, points: 1 }).lean(), User.findById(userId).select("pointsBalance tier").lean()]);
  return rewards
    .filter((reward) => !reward.tiers?.length || reward.tiers.includes(user?.tier))
    .map((reward) => ({ ...toReward(reward), canRedeem: (user?.pointsBalance || 0) >= reward.points && (!reward.stock || reward.redeemedCount < reward.stock) }));
}

export async function history(userId, { page = 1, limit = 20 }) {
  const filter = { user: userId };
  const [items, total] = await Promise.all([
    RewardTransaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    RewardTransaction.countDocuments(filter),
  ]);
  return {
    items: items.map((row) => ({ transactionId: String(row._id), points: row.points, type: row.points > 0 ? "earned" : "spent", kind: row.type, source: row.source, title: row.title, referenceId: row.referenceId, expiresAt: row.expiresAt, createdAt: row.createdAt })),
    page,
    limit,
    total,
  };
}

/** Swaps points for a reward: spends the points and issues a personal coupon. */
export async function redeem(userId, rewardId) {
  const reward = await Reward.findOne({ _id: objectId(rewardId, "reward ID"), isActive: true });
  if (!reward) throw new AppError(404, "Reward not found");
  const user = await User.findById(userId).select("tier pointsBalance").lean();
  if (reward.tiers?.length && !reward.tiers.includes(user?.tier)) throw new AppError(403, "This reward is for another tier");
  if ((user?.pointsBalance || 0) < reward.points) throw new AppError(409, "Not enough points");
  if (reward.stock) {
    const claimed = await Reward.updateOne({ _id: reward._id, redeemedCount: { $lt: reward.stock } }, { $inc: { redeemedCount: 1 } });
    if (!claimed.modifiedCount) throw new AppError(409, "This reward is out of stock");
  } else {
    await Reward.updateOne({ _id: reward._id }, { $inc: { redeemedCount: 1 } });
  }
  const code = `RW${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const expiresAt = new Date(Date.now() + reward.validDays * 86_400_000);
  try {
    await spendPoints({ userId, points: reward.points, source: "reward", title: `Redeemed: ${reward.name}`, referenceType: "reward", referenceId: String(reward._id), dedupeKey: `reward:${userId}:${code}` });
  } catch (err) {
    await Reward.updateOne({ _id: reward._id }, { $inc: { redeemedCount: -1 } });
    throw err;
  }
  const type = reward.kind === "dish" ? "flat" : reward.kind;
  await Coupon.create({
    code,
    title: reward.name,
    description: reward.description || `Reward for ${reward.points} points`,
    type,
    value: reward.kind === "percent" ? reward.value : reward.kind === "free_delivery" ? 0 : reward.value,
    maxDiscountPaise: reward.maxDiscountPaise || 0,
    minOrderPaise: reward.minOrderPaise || 0,
    validTo: expiresAt,
    usageLimit: 1,
    perUserLimit: 1,
    segment: null,
    isPublic: false,
    fundedBy: "platform",
  });
  const redemption = await RewardRedemption.create({ user: userId, reward: reward._id, rewardName: reward.name, points: reward.points, couponCode: code, expiresAt });
  return { redemptionId: String(redemption._id), reward: toReward(reward), couponCode: code, expiresAt, pointsLeft: (user.pointsBalance || 0) - reward.points };
}

export async function myRedemptions(userId) {
  const rows = await RewardRedemption.find({ user: userId }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map((row) => ({ redemptionId: String(row._id), rewardName: row.rewardName, points: row.points, couponCode: row.couponCode, expiresAt: row.expiresAt, status: row.expiresAt < new Date() && row.status === "issued" ? "expired" : row.status, createdAt: row.createdAt }));
}

// ------------------------------------------------------------------ referrals

async function ensureReferralCode(userId) {
  const user = await User.findById(userId).select("referralCode name").lean();
  if (user?.referralCode) return user.referralCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const base = String(user?.name || "MEAL").replace(/[^a-z]/gi, "").slice(0, 4).toUpperCase() || "MEAL";
    const code = `${base}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    try {
      await User.updateOne({ _id: userId, referralCode: { $exists: false } }, { $set: { referralCode: code } });
      const updated = await User.findById(userId).select("referralCode").lean();
      if (updated?.referralCode) return updated.referralCode;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new AppError(503, "Could not create a referral code");
}

export async function myReferrals(userId) {
  const code = await ensureReferralCode(userId);
  const settings = await loyalty();
  const [rows, earned] = await Promise.all([
    Referral.find({ referrer: userId }).populate("referee", "name createdAt").sort({ createdAt: -1 }).limit(100).lean(),
    RewardTransaction.aggregate([{ $match: { user: new mongoose.Types.ObjectId(String(userId)), source: "referral" } }, { $group: { _id: null, points: { $sum: "$points" } } }]),
  ]);
  return {
    code,
    shareLink: `${env.publicBaseUrl}/invite/${code}`,
    shareText: `Order home-style meals on MealJi with my code ${code} and we both get ${settings.pointsReferral} points.`,
    pointsPerReferral: settings.pointsReferral,
    stats: { invited: rows.length, converted: rows.filter((row) => row.status === "converted").length, pointsEarned: earned[0]?.points || 0 },
    referrals: rows.map((row) => ({ name: row.referee?.name ? row.referee.name.split(" ")[0] : "Friend", status: row.status, joinedAt: row.referee?.createdAt || row.createdAt, convertedAt: row.convertedAt })),
  };
}

/** A new customer enters a friend's code (before their first delivered order). */
export async function applyReferralCode(userId, code) {
  const referrer = await User.findOne({ referralCode: String(code).trim().toUpperCase() }).select("_id").lean();
  if (!referrer) throw new AppError(404, "This referral code is not valid");
  if (String(referrer._id) === String(userId)) throw new AppError(409, "You cannot use your own code");
  const delivered = await Order.countDocuments({ user: userId, status: "delivered" });
  if (delivered > 0) throw new AppError(409, "Referral codes are for new customers");
  if (await Referral.exists({ referee: userId })) throw new AppError(409, "You already used a referral code");
  await Referral.create({ referrer: referrer._id, referee: userId, code: String(code).toUpperCase() });
  await User.updateOne({ _id: userId }, { $set: { referredBy: referrer._id } });
  const settings = await loyalty();
  if (!settings.referralRequiresDelivery) await convertReferral(userId, null);
  return { applied: true };
}

/**
 * Pays both sides once the referee's first order is delivered. Fraud check:
 * the referrer and referee must not share a device.
 */
export async function convertReferral(refereeId, orderId) {
  const referral = await Referral.findOne({ referee: refereeId, status: "pending" });
  if (!referral) return null;
  const [refereeDevices, referrerDevices] = await Promise.all([
    DeviceToken.distinct("deviceId", { user: refereeId }),
    DeviceToken.distinct("deviceId", { user: referral.referrer }),
  ]);
  if (refereeDevices.some((device) => referrerDevices.includes(device))) {
    referral.status = "rejected";
    referral.rejectReason = "same_device";
    await referral.save();
    return referral;
  }
  const settings = await loyalty();
  referral.status = "converted";
  referral.order = orderId;
  referral.convertedAt = new Date();
  await referral.save();
  if (settings.pointsReferral > 0) {
    await earnPoints({ userId: referral.referrer, points: settings.pointsReferral, source: "referral", title: "Your friend's first order", referenceType: "referral", referenceId: String(referral._id), dedupeKey: `referral:${referral._id}:referrer` });
    await earnPoints({ userId: refereeId, points: settings.pointsReferral, source: "referral", title: "Welcome bonus for joining with a code", referenceType: "referral", referenceId: String(referral._id), dedupeKey: `referral:${referral._id}:referee` });
  }
  await publishEventSafe("referral.converted", { referralId: String(referral._id), userId: String(referral.referrer), refereeId: String(refereeId) });
  return referral;
}

// ------------------------------------------------------------------ jobs

/** Daily 09:00 IST: birthday points (once a year) and expiry of old points. */
export async function dailyLoyaltyRun() {
  const settings = await loyalty();
  if (!settings.enabled) return 0;
  let count = 0;
  const { month, day, year } = istParts();
  const mmdd = `-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (settings.pointsBirthday > 0) {
    const birthdays = await User.find({ dob: { $regex: `${mmdd}$` }, deletedAt: null, birthdayRewardYear: { $ne: year } }).select("_id").limit(5000).lean();
    for (const user of birthdays) {
      await earnPoints({ userId: user._id, points: settings.pointsBirthday, source: "birthday", title: "Happy birthday from MealJi", dedupeKey: `birthday:${user._id}:${year}` });
      await User.updateOne({ _id: user._id }, { $set: { birthdayRewardYear: year } });
      count += 1;
    }
  }
  const expired = await RewardTransaction.find({ remaining: { $gt: 0 }, expiresAt: { $ne: null, $lte: new Date() } }).limit(5000);
  for (const lot of expired) {
    const points = lot.remaining;
    lot.remaining = 0;
    await lot.save();
    const result = await User.updateOne({ _id: lot.user, pointsBalance: { $gte: points } }, { $inc: { pointsBalance: -points } });
    if (!result.modifiedCount) await User.updateOne({ _id: lot.user }, { $set: { pointsBalance: 0 } });
    await RewardTransaction.create({ user: lot.user, points: -points, type: "expired", source: "expiry", title: "Points expired", referenceId: String(lot._id), dedupeKey: `expire:${lot._id}` }).catch((err) => {
      if (err?.code !== 11000) logger.warn({ err: err.message }, "Expiry row failed");
    });
    count += 1;
  }
  await RewardRedemption.updateMany({ status: "issued", expiresAt: { $lt: new Date() } }, { $set: { status: "expired" } });
  return count;
}

// ------------------------------------------------------------------ admin

const REWARD_FIELDS = ["name", "description", "imageUrl", "points", "kind", "value", "maxDiscountPaise", "minOrderPaise", "validDays", "stock", "tiers", "sortOrder", "isActive"];

export async function saveReward(rewardId, input) {
  const data = Object.fromEntries(REWARD_FIELDS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  if (input.dishId !== undefined) data.dish = input.dishId ? objectId(input.dishId, "dish ID") : null;
  const errors = [];
  if (!rewardId && !data.name) errors.push({ field: "name", message: "Name is required" });
  if (data.points !== undefined && (!Number.isInteger(data.points) || data.points < 1)) errors.push({ field: "points", message: "Points must be a whole number above 0" });
  if (data.kind !== undefined && !["flat", "percent", "free_delivery", "dish"].includes(data.kind)) errors.push({ field: "kind", message: "Kind: flat, percent, free_delivery or dish" });
  if (!rewardId && (!data.kind || !data.points)) errors.push({ field: "kind", message: "Kind and points are required" });
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  if (!rewardId) return toReward(await Reward.create(data));
  const reward = await Reward.findByIdAndUpdate(objectId(rewardId, "reward ID"), { $set: data }, { new: true });
  if (!reward) throw new AppError(404, "Reward not found");
  return toReward(reward);
}

export async function listRewardsAdmin() {
  return (await Reward.find().sort({ sortOrder: 1, points: 1 }).lean()).map((reward) => ({ ...toReward(reward), redeemedCount: reward.redeemedCount || 0 }));
}

export async function adjustPoints({ userId, points, reason, actor }) {
  if (!Number.isInteger(points) || points === 0) throw new AppError(422, "Points must be a non-zero whole number");
  const key = `admin:${userId}:${Date.now()}`;
  if (points > 0) await earnPoints({ userId, points, source: "admin", title: reason, dedupeKey: key, actor, reason });
  else await spendPoints({ userId, points: -points, source: "admin", type: "adjusted", title: reason, dedupeKey: key, actor, reason });
  return summary(userId);
}

export async function listReferrals({ status, page = 1, limit = 25 }) {
  const filter = status ? { status } : {};
  const [items, total] = await Promise.all([
    Referral.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("referrer", "name phoneNumber").populate("referee", "name phoneNumber").lean(),
    Referral.countDocuments(filter),
  ]);
  return {
    items: items.map((row) => ({ referralId: String(row._id), code: row.code, status: row.status, rejectReason: row.rejectReason, referrer: row.referrer ? { userId: String(row.referrer._id), name: row.referrer.name, phone: row.referrer.phoneNumber } : null, referee: row.referee ? { userId: String(row.referee._id), name: row.referee.name, phone: row.referee.phoneNumber } : null, convertedAt: row.convertedAt, createdAt: row.createdAt })),
    page,
    limit,
    total,
  };
}

export async function liability() {
  const settings = await loyalty();
  const [row] = await User.aggregate([{ $match: { pointsBalance: { $gt: 0 } } }, { $group: { _id: null, points: { $sum: "$pointsBalance" }, holders: { $sum: 1 } } }]);
  const tiers = await User.aggregate([{ $match: { tier: { $ne: null } } }, { $group: { _id: "$tier", users: { $sum: 1 } } }]);
  const today = istDateKey();
  const monthAgo = addIstDays(today, -30);
  const flows = await RewardTransaction.aggregate([
    { $match: { createdAt: { $gte: new Date(`${monthAgo}T00:00:00+05:30`) } } },
    { $group: { _id: "$type", points: { $sum: "$points" } } },
  ]);
  return {
    outstandingPoints: row?.points || 0,
    holders: row?.holders || 0,
    liabilityPaise: (row?.points || 0) * settings.pointValuePaise,
    last30Days: Object.fromEntries(flows.map((flow) => [flow._id, flow.points])),
    tiers: tiers.map((tier) => ({ tier: tier._id, users: tier.users })),
  };
}
