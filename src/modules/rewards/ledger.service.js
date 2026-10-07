import { AppError } from "../../common/errors/AppError.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { RewardTransaction } from "./ledger.model.js";

/** Tier for lifetime points from the loyalty settings (names + thresholds). */
export function tierFor(lifetimePoints, loyalty) {
  const names = loyalty.tierNames || [];
  const thresholds = loyalty.tierThresholds || [];
  let tier = names[0] || null;
  names.forEach((name, index) => {
    if (lifetimePoints >= (thresholds[index] ?? Infinity)) tier = name;
  });
  return tier;
}

async function refreshTier(userId) {
  const loyalty = (await resolveSetting("loyalty")).values;
  const user = await User.findById(userId).select("lifetimePoints tier").lean();
  const tier = tierFor(user?.lifetimePoints || 0, loyalty);
  if (tier !== user?.tier) {
    await User.updateOne({ _id: userId }, { $set: { tier } });
    if (user?.tier) await publishEventSafe("reward.tier_changed", { userId: String(userId), from: user.tier, to: tier });
  }
}

/**
 * Credits points. Idempotent by `dedupeKey` (e.g. "order:<id>:earn"): a second
 * call with the same key does nothing and returns null.
 */
export async function earnPoints({ userId, points, source, title, referenceType = null, referenceId = null, dedupeKey, actor = null, reason = null, session = null }) {
  if (!Number.isInteger(points) || points <= 0) return null;
  const loyalty = (await resolveSetting("loyalty")).values;
  const expiresAt = loyalty.expiryMonths > 0 ? new Date(Date.now() + loyalty.expiryMonths * 30 * 24 * 3600 * 1000) : null;
  try {
    const [row] = await RewardTransaction.create([{
      user: userId, points, type: source === "admin" ? "adjusted" : "earned", source, title, referenceType, referenceId, remaining: points, expiresAt, dedupeKey, actor, reason,
    }], session ? { session } : {});
    await User.updateOne({ _id: userId }, { $inc: { pointsBalance: points, lifetimePoints: points } }, { session: session || undefined });
    await refreshTier(userId);
    await publishEventSafe("reward.earned", { userId: String(userId), points, source, referenceId });
    return row;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/** Spends points (oldest earned first). Throws when the balance is too low. */
export async function spendPoints({ userId, points, source, title, referenceType = null, referenceId = null, dedupeKey, type = "redeemed", actor = null, reason = null, session = null }) {
  if (!Number.isInteger(points) || points <= 0) return null;
  const updated = await User.updateOne({ _id: userId, pointsBalance: { $gte: points } }, { $inc: { pointsBalance: -points } }, { session: session || undefined });
  if (!updated.modifiedCount) throw new AppError(409, "Not enough points");
  let left = points;
  const lots = await RewardTransaction.find({ user: userId, remaining: { $gt: 0 } }).sort({ expiresAt: 1, createdAt: 1 }).session(session || null);
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.remaining, left);
    lot.remaining -= take;
    left -= take;
    await lot.save({ session: session || undefined });
  }
  try {
    const [row] = await RewardTransaction.create([{ user: userId, points: -points, type, source, title, referenceType, referenceId, dedupeKey, actor, reason }], session ? { session } : {});
    if (type === "redeemed") await publishEventSafe("reward.redeemed", { userId: String(userId), points, source, referenceId });
    return row;
  } catch (err) {
    if (err?.code === 11000) {
      // Already recorded: undo the balance change made above.
      await User.updateOne({ _id: userId }, { $inc: { pointsBalance: points } });
      return null;
    }
    throw err;
  }
}

/** Gives back points spent on something that was cancelled (idempotent). */
export async function refundSpentPoints({ userId, referenceId, title, session = null }) {
  const spent = await RewardTransaction.findOne({ user: userId, referenceId: String(referenceId), type: "redeemed" }).session(session || null).lean();
  if (!spent) return null;
  return earnPoints({ userId, points: -spent.points, source: "cancellation", title, referenceType: spent.referenceType, referenceId: String(referenceId), dedupeKey: `refund:${spent._id}`, session });
}

/** Takes back points earned on something later cancelled or refunded (idempotent). */
export async function reverseEarnedPoints({ userId, referenceId, title }) {
  const earned = await RewardTransaction.findOne({ user: userId, referenceId: String(referenceId), type: "earned" }).lean();
  if (!earned) return null;
  const user = await User.findById(userId).select("pointsBalance").lean();
  const points = Math.min(earned.points, Math.max(0, user?.pointsBalance || 0));
  if (!points) return null;
  return spendPoints({ userId, points, source: "reversal", type: "reversed", title, referenceId: String(referenceId), dedupeKey: `reverse:${earned._id}` });
}
