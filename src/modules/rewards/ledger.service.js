import { AppError } from "../../common/errors/AppError.js";
import { withTransaction } from "../../config/database.js";
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
  // The ledger row and the balance are written together (one transaction), so a
  // failure between them can never leave a row that is never credited.
  const write = async (tx) => {
    const [created] = await RewardTransaction.create([{
      user: userId, points, type: source === "admin" ? "adjusted" : "earned", source, title, referenceType, referenceId, remaining: points, expiresAt, dedupeKey, actor, reason,
    }], tx ? { session: tx } : {});
    await User.updateOne({ _id: userId }, { $inc: { pointsBalance: points, lifetimePoints: points } }, { session: tx || undefined });
    return created;
  };
  try {
    const row = session ? await write(session) : await withTransaction(write);
    await refreshTier(userId);
    await publishEventSafe("reward.earned", { userId: String(userId), points, source, title, referenceId });
    return row;
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

/** Spends points (oldest earned first). Throws when the balance is too low. */
export async function spendPoints({ userId, points, source, title, referenceType = null, referenceId = null, dedupeKey, type = "redeemed", actor = null, reason = null, session = null }) {
  if (!Number.isInteger(points) || points <= 0) return null;
  // A replay of the same spend: nothing to do (and nothing to undo afterwards).
  if (dedupeKey && (await RewardTransaction.exists({ dedupeKey }).session(session || null))) return null;
  const updated = await User.updateOne({ _id: userId, pointsBalance: { $gte: points } }, { $inc: { pointsBalance: -points } }, { session: session || undefined });
  if (!updated.modifiedCount) throw new AppError(409, "Not enough points");
  // Oldest lots first. Each lot is taken atomically, so the expiry job (or another
  // spend) working on the same lot can never write back a stale amount.
  let left = points;
  for (let round = 0; left > 0 && round < 5; round += 1) {
    const lots = await RewardTransaction.find({ user: userId, remaining: { $gt: 0 } }).sort({ expiresAt: 1, createdAt: 1 }).select("remaining").session(session || null).lean();
    if (!lots.length) break;
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(lot.remaining, left);
      const taken = await RewardTransaction.updateOne({ _id: lot._id, remaining: { $gte: take } }, { $inc: { remaining: -take } }, { session: session || undefined });
      if (taken.modifiedCount) left -= take;
    }
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
