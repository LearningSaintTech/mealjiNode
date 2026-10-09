import { AppError } from "../../common/errors/AppError.js";
import { countryOrDefault, normalizeMobile } from "../../common/phone.util.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { sendOtp, verifyOtp } from "../../infrastructure/otpSession.service.js";
import { revokeAccessToken } from "../../infrastructure/refreshToken.service.js";
import { storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { env } from "../../config/env.js";
import { Address, toAddress } from "../address/address.model.js";
import { currentConsents, recordConsent } from "../consent/consent.model.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { toProfile } from "../user/user.mapper.js";
import { User } from "../user/user.model.js";
import { userRepository } from "../user/user.repository.js";
import { phoneChangePatch } from "../user/user.status.js";

const PHONE_CHANGE = "phone-change";

export async function getProfile(userId) {
  const user = await userRepository.findById(userId);
  if (!user || user.deletedAt) throw new AppError(404, "Account not found");
  return toProfile(user);
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
  if (input.dob !== undefined) patch.dob = input.dob || null;
  if (input.gender !== undefined) patch.gender = input.gender || null;
  if (input.avatarUrl !== undefined) patch.avatarUrl = assertOwnFileUrl(input.avatarUrl, "Avatar");
  const before = await userRepository.findById(userId);
  const user = await userRepository.updateById(userId, patch);
  const wasComplete = before?.name && before.name !== "User";
  await publishEventSafe("user.profile_updated", { userId: String(userId), fields: Object.keys(patch), completed: !wasComplete && patch.name && patch.name !== "User" }, { aggregate: { type: "user", id: userId } });
  return toProfile(user);
}

const CHANNELS = ["push", "whatsapp", "email", "sms"];
const TOPICS = ["offers", "rewards", "account"];

export async function getPreferences(userId) {
  const profile = await getProfile(userId);
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
  const taken = await userRepository.findByPhone(code, phone);
  if (taken) throw new AppError(409, "This number is already used by another account");
  const cooldown = `otp:cooldown:${PHONE_CHANGE}:${userId}`;
  const existing = await storeGetOptional(cooldown);
  if (existing.value) throw new AppError(429, "Please wait before requesting another OTP.");
  await sendOtp({ subjectId: `${userId}:${phone}`, purpose: PHONE_CHANGE, phoneNumber: phone });
  await storeSet(cooldown, "1", env.otpResendCooldownSec).catch(() => {});
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
  const now = new Date();
  await userRepository.updateById(userId, {
    deletedAt: now,
    deletionReason: reason ? String(reason).slice(0, 300) : null,
    isActive: false,
    sessionsRevokedAt: now,
  });
  await publishEventSafe("user.deleted", { userId: String(userId), purgeAfterDays: 30 }, { aggregate: { type: "user", id: userId } });
  return { deleted: true, purgeAfter: new Date(now.getTime() + 30 * 24 * 3600 * 1000) };
}

/** Data access request (DPDP): everything we hold about the person, as JSON. */
export async function exportData(userId) {
  const { Order } = await import("../order/order.model.js");
  const profile = await getProfile(userId);
  const [addresses, orders, consents] = await Promise.all([
    Address.find({ user: userId }).lean(),
    Order.find({ user: userId }).sort({ createdAt: -1 }).limit(500).lean(),
    currentConsents(userId),
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
      items: (order.items || []).map((item) => ({ name: item.name, qty: item.qty })),
    })),
    consents,
  };
}
