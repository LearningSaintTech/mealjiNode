import { AppError } from "../../common/errors/AppError.js";
import { countryOrDefault, normalizeMobile } from "../../common/phone.util.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { sendOtp, verifyOtp } from "../../infrastructure/otpSession.service.js";
import { revokeAccessToken } from "../../infrastructure/refreshToken.service.js";
import { storeGetOptional, storeIncr, storeSet } from "../../infrastructure/redisStore.js";
import { env } from "../../config/env.js";
import { Address, toAddress } from "../address/address.model.js";
import { currentConsents, recordConsent } from "../consent/consent.model.js";
import { assertOwnFileUrl, assertUploadedSize } from "../upload/upload.service.js";
import { toProfile } from "../user/user.mapper.js";
import { User } from "../user/user.model.js";
import { userRepository } from "../user/user.repository.js";
import { phoneChangePatch } from "../user/user.status.js";

const PHONE_CHANGE = "phone-change";

export async function getProfile(userId, { stats = true, user: loaded = null } = {}) {
  const user = loaded || await userRepository.findById(userId);
  if (!user || user.deletedAt) throw new AppError(404, "Account not found");
  return stats ? { ...toProfile(user), stats: await profileStats(userId) } : toProfile(user);
}

/**
 * Profile header counts: orders placed, favourites (dishes still on a menu),
 * saved addresses and saved payment methods (cards / UPI saved at checkout).
 */
async function profileStats(userId) {
  const [{ Order }, { Favorite }, { KitchenDish }, { SavedPaymentMethod }] = await Promise.all([
    import("../order/order.model.js"),
    import("../favorites/favorites.model.js"),
    import("../catalog/catalog.model.js"),
    import("../payment/paymentMethod.service.js"),
  ]);
  const [orders, favoriteDishes, addresses, paymentMethods] = await Promise.all([
    Order.countDocuments({ user: userId, status: { $nin: ["payment_pending", "payment_failed"] } }),
    Favorite.find({ user: userId }).select("dish").limit(500).lean(),
    Address.countDocuments({ user: userId, deletedAt: null }),
    SavedPaymentMethod.countDocuments({ user: userId }),
  ]);
  const favorites = favoriteDishes.length ? await KitchenDish.countDocuments({ _id: { $in: favoriteDishes.map((row) => row.dish) }, isActive: true, approvalStatus: "live" }) : 0;
  return { orders, favorites, addresses, paymentMethods };
}

export async function updateProfile(userId, input) {
  const patch = {};
  if (input.name !== undefined) patch.name = String(input.name).trim();
  if (input.email !== undefined) {
    const email = input.email ? String(input.email).trim().toLowerCase() : null;
    const current = await User.findById(userId).select("email").lean();
    patch.email = email;
    if (email !== current?.email) patch.emailVerified = false;
  }
  if (input.dob !== undefined) {
    patch.dob = input.dob || null;
    patch.dobMonthDay = input.dob ? String(input.dob).slice(5, 10) : null;
  }
  if (input.gender !== undefined) patch.gender = input.gender || null;
  if (input.avatarUrl !== undefined) patch.avatarUrl = await assertUploadedSize(assertOwnFileUrl(input.avatarUrl, "Avatar"), "avatar");
  const before = await userRepository.findById(userId);
  const user = await userRepository.updateById(userId, patch);
  const wasComplete = before?.name && before.name !== "User";
  await publishEventSafe("user.profile_updated", { userId: String(userId), fields: Object.keys(patch), completed: !wasComplete && patch.name && patch.name !== "User" }, { aggregate: { type: "user", id: userId } });
  return toProfile(user);
}

const CHANNELS = ["push", "whatsapp", "email", "sms"];
const TOPICS = ["offers", "rewards", "account"];

export async function getPreferences(userId, { user = null } = {}) {
  const profile = await getProfile(userId, { stats: false, user });
  return { ...profile.preferences, consents: await currentConsents(userId) };
}

/**
 * Updates notification and food preferences. Turning a channel or the offers
 * topic on/off is a marketing consent change and is recorded with its source.
 */
export async function updatePreferences(userId, input, { ip = null, deviceId = null } = {}) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, "Account not found");
  const prefs = user.preferences || {};
  const changes = [];
  if (typeof input.language === "string") prefs.language = input.language;
  if (typeof input.vegOnly === "boolean") prefs.vegOnly = input.vegOnly;
  for (const channel of CHANNELS) {
    const value = input.channels?.[channel];
    if (typeof value !== "boolean") continue;
    if (prefs.channels?.[channel] !== value) changes.push({ channel, granted: value });
    prefs.channels = { ...(prefs.channels || {}), [channel]: value };
  }
  for (const topic of TOPICS) {
    const value = input.topics?.[topic];
    if (typeof value !== "boolean") continue;
    prefs.topics = { ...(prefs.topics || {}), [topic]: value };
  }
  user.preferences = prefs;
  user.markModified("preferences");
  await user.save();
  for (const change of changes) {
    await recordConsent({ userId, channel: change.channel, purpose: "marketing", granted: change.granted, source: "app_toggle", ip, deviceId });
  }
  if (changes.length) {
    await publishEventSafe("user.consent_changed", { userId: String(userId), changes }, { aggregate: { type: "user", id: userId } });
  }
  return getPreferences(userId);
}

// Phone change: OTP to the new number, then swap and sign out everywhere.
export async function requestPhoneChange(userId, { countryCode, phoneNumber }) {
  const phone = normalizeMobile(phoneNumber);
  const code = countryOrDefault(countryCode);
  const current = await userRepository.findById(userId);
  if (current && current.phoneNumber === phone && (current.countryCode || "+91") === code) throw new AppError(422, "This is already your number");
  // Limits come first and the answer is the same whether or not the number has an
  // account, so this cannot be used to test which numbers are registered.
  const cooldown = `otp:cooldown:${PHONE_CHANGE}:${userId}`;
  const existing = await storeGetOptional(cooldown);
  if (existing.value) throw new AppError(429, "Please wait before requesting another OTP.");
  const today = await storeIncr(`otp:phone-change:${userId}:${new Date().toISOString().slice(0, 10)}`, 86_400);
  if (today > 5) throw new AppError(429, "Too many number changes today. Try again tomorrow.");
  await storeSet(cooldown, "1", env.otpResendCooldownSec).catch(() => {});
  const taken = await userRepository.findByPhone(code, phone);
  // A taken number gets no SMS; the change is refused when the code is entered.
  if (!taken) await sendOtp({ subjectId: `${userId}:${phone}`, purpose: PHONE_CHANGE, phoneNumber: phone });
  return { otpSent: true, phoneNumber: phone, resendAfterSec: env.otpResendCooldownSec };
}

export async function confirmPhoneChange(userId, { countryCode, phoneNumber, otp }, { jti, exp }) {
  const phone = normalizeMobile(phoneNumber);
  const code = countryOrDefault(countryCode);
  await verifyOtp({ subjectId: `${userId}:${phone}`, purpose: PHONE_CHANGE, otp });
  const taken = await userRepository.findByPhone(code, phone);
  if (taken && String(taken._id) !== String(userId)) throw new AppError(409, "This number is already used by another account");
  const user = await userRepository.updateById(userId, { countryCode: code, phoneNumber: phone, ...phoneChangePatch() });
  await revokeAccessToken({ jti, exp }).catch(() => {});
  await publishEventSafe("user.phone_changed", { userId: String(userId) }, { aggregate: { type: "user", id: userId } });
  return { profile: toProfile(user), signedOut: true };
}

/**
 * Closes the account now (sign-in stops working everywhere) and lets the purge
 * job anonymise it after 30 days. Signing in again before then restores it.
 */
export async function deleteAccount(userId, { reason = null } = {}) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(404, "Account not found");
  if (user.role?.slug !== "user") throw new AppError(403, "Staff accounts are closed by a super admin");
  // An order still being made or delivered must finish first (refunds and help need the account).
  const [{ Order }, { ACTIVE_STATUSES }] = await Promise.all([import("../order/order.model.js"), import("../order/order.states.js")]);
  const inProgress = await Order.exists({ user: userId, status: { $in: ACTIVE_STATUSES } });
  if (inProgress) throw new AppError(409, "You have an order on the way. You can close your account once it is delivered.");
  // A Meal Ji Plus plan stops renewing and autopay is cancelled; paid days stay usable if the account is restored.
  const { cancel, currentSubscription } = await import("../subscription/subscription.service.js");
  const plan = await currentSubscription(userId);
  let planCancelled = false;
  if (plan && plan.status !== "cancel_scheduled") {
    await cancel(plan, { reasonId: null, comment: "Account closed" }, "system:account_closed");
    planCancelled = true;
  } else if (plan) planCancelled = true;
  const now = new Date();
  await userRepository.updateById(userId, {
    deletedAt: now,
    deletionReason: reason ? String(reason).slice(0, 300) : null,
    isActive: false,
    sessionsRevokedAt: now,
  });
  await publishEventSafe("user.deleted", { userId: String(userId), purgeAfterDays: 30 }, { aggregate: { type: "user", id: userId } });
  return { deleted: true, planCancelled, purgeAfter: new Date(now.getTime() + 30 * 24 * 3600 * 1000) };
}

/**
 * Data access request (DPDP): everything we hold about the person, as JSON.
 * Gateway tokens, OTPs and session data are never included.
 */
export async function exportData(userId) {
  const [{ Order }, { Subscription }, { Payment, Refund }, { SupportTicket }, { RewardTransaction }, { Favorite }, { SavedPaymentMethod, toMethod }, { Referral }] = await Promise.all([
    import("../order/order.model.js"),
    import("../subscription/subscription.model.js"),
    import("../payment/payment.model.js"),
    import("../support/support.model.js"),
    import("../rewards/ledger.model.js"),
    import("../favorites/favorites.model.js"),
    import("../payment/paymentMethod.service.js"),
    import("../rewards/rewards.model.js"),
  ]);
  const profile = await getProfile(userId);
  const user = await User.findById(userId).select("pointsBalance lifetimePoints").lean();
  const [addresses, orders, subscriptions, payments, refunds, tickets, points, favorites, methods, referrals, consents, preferences] = await Promise.all([
    Address.find({ user: userId }).lean(),
    Order.find({ user: userId }).sort({ createdAt: -1 }).limit(500).lean(),
    Subscription.find({ user: userId, status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).lean(),
    Payment.find({ user: userId, status: { $ne: "created" } }).sort({ createdAt: -1 }).limit(500).lean(),
    Refund.find({ user: userId }).sort({ createdAt: -1 }).limit(200).lean(),
    SupportTicket.find({ user: userId }).sort({ createdAt: -1 }).limit(200).lean(),
    RewardTransaction.find({ user: userId }).sort({ createdAt: -1 }).limit(500).lean(),
    Favorite.find({ user: userId }).populate("dish", "name").lean(),
    SavedPaymentMethod.find({ user: userId }).lean(),
    Referral.find({ $or: [{ referrer: userId }, { referee: userId }] }).lean(),
    currentConsents(userId),
    getPreferences(userId),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    profile,
    addresses: addresses.map(toAddress),
    orders: orders.map((order) => ({
      orderNumber: order.orderNumber,
      status: order.status,
      placedAt: order.createdAt,
      totalPaise: order.bill?.grandTotalPaise,
      paymentMethod: order.paymentMethod,
      deliveryAddress: order.address?.fullAddress || null,
      items: (order.items || []).map((item) => ({ name: item.name, qty: item.qty })),
    })),
    subscriptions: subscriptions.map((sub) => ({ plan: sub.planSnapshot?.name, status: sub.status, startDate: sub.startDate, validTill: sub.validTill, billingMethod: sub.billingMethod, address: sub.address?.fullAddress || null, cancellation: sub.cancellation?.reason || null, createdAt: sub.createdAt })),
    payments: payments.map((payment) => ({ for: payment.refType, amountPaise: payment.amountPaise, status: payment.status, method: payment.method, refundedPaise: payment.refundedPaise || 0, at: payment.capturedAt || payment.createdAt })),
    refunds: refunds.map((refund) => ({ amountPaise: refund.amountPaise, status: refund.status, reason: refund.reason, at: refund.createdAt })),
    supportTickets: tickets.map((ticket) => ({ number: ticket.number, category: ticket.category, issueType: ticket.issueType, subject: ticket.subject, description: ticket.description, status: ticket.status, createdAt: ticket.createdAt })),
    points: { balance: user?.pointsBalance || 0, lifetime: user?.lifetimePoints || 0, history: points.map((row) => ({ title: row.title, points: row.points, type: row.type, at: row.createdAt, expiresAt: row.expiresAt || null })) },
    wallet: { pointsBalance: user?.pointsBalance || 0 },
    favorites: favorites.map((row) => ({ dish: row.dish?.name || null, addedAt: row.createdAt })),
    savedPaymentMethods: methods.map(toMethod).map(({ paymentMethodId, title, subtitle, type }) => ({ paymentMethodId, title, subtitle, type })),
    referrals: referrals.map((row) => ({ role: String(row.referrer) === String(userId) ? "referrer" : "referred", status: row.status, at: row.createdAt })),
    notificationPreferences: preferences,
    consents,
  };
}
