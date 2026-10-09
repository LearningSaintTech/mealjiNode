import mongoose from "mongoose";
import { istParts } from "../../common/time.js";
import { logger } from "../../config/logger.js";

const { ObjectId } = mongoose.Schema.Types;

// Denormalised traits per customer, kept fresh by events and a nightly
// recompute. Segments are compiled to queries over this collection.
const userStatsSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: "User", required: true, unique: true },
    // Dynamic segments this customer is in, precomputed by materializeSegments().
    segmentIds: { type: [ObjectId], default: [], index: true },
    ordersCount: { type: Number, default: 0 },
    deliveredOrdersCount: { type: Number, default: 0 },
    cancelledOrdersCount: { type: Number, default: 0 },
    lifetimeValuePaise: { type: Number, default: 0 },
    avgOrderValuePaise: { type: Number, default: 0 },
    firstOrderAt: Date,
    lastOrderAt: Date,
    daysSinceLastOrder: { type: Number, default: null },
    favCategoryIds: { type: [String], default: [] },
    favDishIds: { type: [String], default: [] },
    vegShare: { type: Number, default: null },
    couponUsageCount: { type: Number, default: 0 },
    pointsBalance: { type: Number, default: 0 },
    tier: { type: String, default: null },
    isPlusMember: { type: Boolean, default: false },
    subscriptionStatus: { type: String, default: "none" },
    planCode: { type: String, default: null },
    subscriptionEndsAt: Date,
    ratingAvgGiven: { type: Number, default: null },
    lastAppOpenAt: Date,
    preferredHour: { type: Number, default: null }, // most frequent app-open hour (IST)
    platform: String,
    appVersion: String,
    city: String,
    kitchenId: String,
    pincode: String,
    signupAt: Date,
    acquisitionSource: String,
    referralCount: { type: Number, default: 0 },
    hasPushToken: { type: Boolean, default: false },
    whatsappOptIn: { type: Boolean, default: false },
    emailReachable: { type: Boolean, default: false },
    smsAllowed: { type: Boolean, default: true },
    cartItems: { type: Number, default: 0 },
    cartUpdatedAt: Date,
    computedAt: Date,
  },
  { versionKey: false },
);
for (const field of ["daysSinceLastOrder", "lastOrderAt", "isPlusMember", "city", "kitchenId", "tier", "deliveredOrdersCount", "lifetimeValuePaise", "signupAt"]) {
  userStatsSchema.index({ [field]: 1 });
}
export const UserStats = mongoose.model("UserStats", userStatsSchema);

export const TRAIT_FIELDS = {
  ordersCount: "number", deliveredOrdersCount: "number", cancelledOrdersCount: "number", lifetimeValuePaise: "money", avgOrderValuePaise: "money",
  firstOrderAt: "date", lastOrderAt: "date", daysSinceLastOrder: "number", vegShare: "number", couponUsageCount: "number", pointsBalance: "number",
  tier: "string", isPlusMember: "boolean", subscriptionStatus: "string", planCode: "string", subscriptionEndsAt: "date", ratingAvgGiven: "number",
  lastAppOpenAt: "date", preferredHour: "number", platform: "string", appVersion: "string", city: "string", kitchenId: "string", pincode: "string",
  signupAt: "date", acquisitionSource: "string", referralCount: "number", hasPushToken: "boolean", whatsappOptIn: "boolean", emailReachable: "boolean",
  smsAllowed: "boolean", cartItems: "number", cartUpdatedAt: "date", favCategoryIds: "list", favDishIds: "list",
};

/** Recomputes every trait of one customer from source collections. */
export async function computeTraits(userId) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const [{ User }, { Order }, { Address }, { DeviceToken }, { Cart }, { CouponRedemption }, { AnalyticsEvent }, rewards] = await Promise.all([
    import("../user/user.model.js"),
    import("../order/order.model.js"),
    import("../address/address.model.js"),
    import("../notification/notification.model.js"),
    import("../cart/cart.model.js"),
    import("../coupon/coupon.model.js"),
    import("../analytics/analytics.model.js"),
    import("../rewards/rewards.model.js"),
  ]);
  const user = await User.findById(id).lean();
  if (!user || user.deletedAt) {
    await UserStats.deleteOne({ user: id });
    return null;
  }
  const [orders, address, devices, cart, coupons, opens, referrals] = await Promise.all([
    Order.find({ user: id, status: { $nin: ["payment_pending", "payment_failed"] } }).select("status bill createdAt items kitchen rating city").lean(),
    Address.findOne({ user: id, deletedAt: null }).sort({ isDefault: -1 }).lean(),
    DeviceToken.countDocuments({ user: id, isValid: true, fcmToken: { $ne: null } }),
    Cart.findOne({ user: id }).lean(),
    CouponRedemption.countDocuments({ user: id, status: "redeemed" }),
    AnalyticsEvent.aggregate([{ $match: { userId: id, "meta.name": "app_opened", occurredAt: { $gte: new Date(Date.now() - 60 * 86_400_000) } } }, { $project: { hour: { $hour: { date: "$occurredAt", timezone: "Asia/Kolkata" } } } }, { $group: { _id: "$hour", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 1 }]).catch(() => []),
    rewards.Referral.countDocuments({ referrer: id, status: "converted" }),
  ]);
  const delivered = orders.filter((order) => order.status === "delivered");
  const ltv = delivered.reduce((sum, order) => sum + (order.bill?.grandTotalPaise || 0), 0);
  const dishCounts = new Map();
  const categoryCounts = new Map();
  let vegItems = 0;
  let items = 0;
  for (const order of delivered) {
    for (const item of order.items || []) {
      if (item.dish) dishCounts.set(String(item.dish), (dishCounts.get(String(item.dish)) || 0) + item.qty);
      items += item.qty;
      if (item.isVeg !== false) vegItems += item.qty;
    }
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key]) => key);
  if (dishCounts.size) {
    const { KitchenDish } = await import("../catalog/catalog.model.js");
    const dishes = await KitchenDish.find({ _id: { $in: top(dishCounts, 20) } }).select("category").lean();
    for (const dish of dishes) if (dish.category) categoryCounts.set(String(dish.category), (categoryCounts.get(String(dish.category)) || 0) + (dishCounts.get(String(dish._id)) || 0));
  }
  const ratings = orders.filter((order) => order.rating?.food).map((order) => order.rating.food);
  const last = delivered.length ? delivered.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)) : null;
  const first = delivered.length ? delivered.reduce((a, b) => (a.createdAt < b.createdAt ? a : b)) : null;
  const sub = user.subscription || {};
  const traits = {
    ordersCount: orders.length,
    deliveredOrdersCount: delivered.length,
    cancelledOrdersCount: orders.filter((order) => order.status === "cancelled").length,
    lifetimeValuePaise: ltv,
    avgOrderValuePaise: delivered.length ? Math.round(ltv / delivered.length) : 0,
    firstOrderAt: first?.createdAt || null,
    lastOrderAt: last?.createdAt || null,
    daysSinceLastOrder: last ? Math.floor((Date.now() - new Date(last.createdAt)) / 86_400_000) : null,
    favCategoryIds: top(categoryCounts, 5),
    favDishIds: top(dishCounts, 10),
    vegShare: items ? Math.round((vegItems / items) * 100) / 100 : null,
    couponUsageCount: coupons,
    pointsBalance: user.pointsBalance || 0,
    tier: user.tier || null,
    isPlusMember: sub.status === "active",
    subscriptionStatus: sub.status || "none",
    planCode: sub.planCode || null,
    subscriptionEndsAt: sub.expiresAt || null,
    ratingAvgGiven: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    lastAppOpenAt: user.lastAppOpenAt || null,
    preferredHour: opens[0]?._id ?? null,
    platform: user.platform || null,
    appVersion: user.appVersion || null,
    city: (address?.city || user.currentLocation?.city || last?.city || "").toLowerCase() || null,
    kitchenId: last ? String(last.kitchen) : null,
    pincode: address?.pincode || user.currentLocation?.postalCode || null,
    signupAt: user.createdAt,
    acquisitionSource: user.acquisition?.source || null,
    referralCount: referrals,
    hasPushToken: devices > 0,
    whatsappOptIn: user.preferences?.channels?.whatsapp === true,
    emailReachable: Boolean(user.email) && user.preferences?.channels?.email !== false,
    smsAllowed: user.preferences?.channels?.sms !== false,
    cartItems: (cart?.items || []).reduce((sum, line) => sum + line.qty, 0),
    cartUpdatedAt: cart?.updatedAt || null,
    computedAt: new Date(),
  };
  await UserStats.updateOne({ user: id }, { $set: traits }, { upsert: true });
  return traits;
}

/** Nightly: recompute traits for every customer, then refresh segment sizes. */
export async function recomputeAllTraits() {
  const { User } = await import("../user/user.model.js");
  const { Role } = await import("../role/role.model.js");
  const role = await Role.findOne({ slug: "user" }).select("_id").lean();
  let count = 0;
  const cursor = User.find({ role: role?._id, deletedAt: null }).select("_id").lean().cursor();
  for await (const user of cursor) {
    try {
      await computeTraits(user._id);
      count += 1;
    } catch (err) {
      logger.warn({ err: err.message, userId: String(user._id) }, "Trait recompute failed");
    }
  }
  // Win-back trigger: people who reached 21 days without an order today.
  const { publishEventSafe } = await import("../../events/eventBus.js");
  const lapsed = await UserStats.find({ lastOrderAt: { $gte: new Date(Date.now() - 22 * 86_400_000), $lt: new Date(Date.now() - 21 * 86_400_000) } }).select("user").lean();
  for (const row of lapsed) await publishEventSafe("traits.inactive_21d", { userId: String(row.user) });
  // daysSinceLastOrder drifts daily even without events.
  await UserStats.updateMany({ lastOrderAt: { $ne: null } }, [{ $set: { daysSinceLastOrder: { $floor: { $divide: [{ $subtract: ["$$NOW", "$lastOrderAt"] }, 86_400_000] } } } }]);
  const { refreshSegmentSizes } = await import("./segment.service.js");
  await refreshSegmentSizes();
  return count;
}

export function currentIstHour() {
  return istParts().hour;
}
