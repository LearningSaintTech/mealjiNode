import { AppError } from "../../common/errors/AppError.js";
import { countryOrDefault, normalizeMobile } from "../../common/phone.util.js";
import { isConsoleRole } from "../../constants/permissions.js";
import { OTP_LENGTH, OTP_PURPOSE, OTP_TTL } from "../../constants/otp.constants.js";
import { env } from "../../config/env.js";
import { hasPendingOtp, sendOtp, verifyOtp } from "../../infrastructure/otpSession.service.js";
import { issueTokenPair, revokeAccessToken, revokeRefreshToken, rotateRefreshToken } from "../../infrastructure/refreshToken.service.js";
import { storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { requireDeviceId } from "../../common/device.util.js";
import { toPublicUser } from "../user/user.mapper.js";
import { isSuspended } from "../user/user.status.js";
import { roleRepository } from "../role/role.repository.js";
import { userRepository } from "../user/user.repository.js";

const OTP_UNAVAILABLE = "OTP service temporarily unavailable. Please try again.";

async function requireRole(slug) {
  const role = await roleRepository.findBySlug(slug);
  if (!role) throw new AppError(500, "Roles are not seeded");
  return role;
}

const cooldownKey = (userId) => `otp:cooldown:${OTP_PURPOSE}:${userId}`;

/**
 * Sends a code unless one went out within the cooldown and is still waiting to
 * be used, on every path (login, staff login, resend), so repeated requests
 * cannot flood a phone with SMS. In that case login answers normally without
 * sending (the code already sent still works) and resend refuses with 429.
 * Once the code is used or locked out, a new one is sent straight away.
 */
async function deliverOtp(user, { onCooldown = "skip" } = {}) {
  const existing = await storeGetOptional(cooldownKey(user._id));
  if (!existing.ok) throw new AppError(503, OTP_UNAVAILABLE);
  if (existing.value && await hasPendingOtp({ subjectId: user._id, purpose: OTP_PURPOSE })) {
    if (onCooldown === "reject") throw new AppError(429, "Please wait before requesting another OTP.");
    return {
      userId: String(user._id),
      message: "OTP already sent",
      otpSent: false,
      otpLength: OTP_LENGTH,
      expiresInSec: OTP_TTL,
      resendAfterSec: env.otpResendCooldownSec,
    };
  }
  await sendOtp({
    subjectId: user._id,
    purpose: OTP_PURPOSE,
    phoneNumber: user.phoneNumber,
  });
  await storeSet(cooldownKey(user._id), "1", env.otpResendCooldownSec, { unavailableMessage: OTP_UNAVAILABLE });
  // The app uses these to size the OTP boxes and run its resend timer, instead
  // of hard-coding them.
  return {
    userId: String(user._id),
    message: "OTP sent successfully",
    otpSent: true,
    otpLength: OTP_LENGTH,
    expiresInSec: OTP_TTL,
    resendAfterSec: env.otpResendCooldownSec,
  };
}

export async function login({ name, countryCode, phoneNumber }) {
  const phone = normalizeMobile(phoneNumber);
  const code = countryOrDefault(countryCode);
  const trimmedName = typeof name === "string" ? name.trim() : "";
  let user = await userRepository.findByPhone(code, phone);

  if (user) {
    if (isSuspended(user)) {
      throw new AppError(403, "Account is suspended");
    }
    const isCustomer = user.role?.slug === "user";
    if (isCustomer && trimmedName && !user.isNumberVerified) {
      user = await userRepository.updateById(user._id, { name: trimmedName, countryCode: code });
    }
    return deliverOtp(user);
  }

  const userRole = await requireRole("user");
  user = await userRepository.create({
    name: trimmedName || "User",
    countryCode: code,
    phoneNumber: phone,
    role: userRole._id,
    isActive: false,
    isNumberVerified: false,
  });
  await publishEventSafe("user.registered", { userId: String(user._id), role: "user" }, { aggregate: { type: "user", id: user._id } });
  return deliverOtp(user);
}

export async function staffLogin({ countryCode, phoneNumber }) {
  const phone = normalizeMobile(phoneNumber);
  const code = countryOrDefault(countryCode);
  const user = await userRepository.findByPhone(code, phone);
  if (!user || !isConsoleRole(user.role)) {
    throw new AppError(404, "No super admin, subadmin, or kitchen account uses this phone number");
  }
  if (isSuspended(user)) {
    throw new AppError(403, "Account is suspended");
  }
  return deliverOtp(user);
}

export async function resendOtp({ userId }) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (isSuspended(user)) {
    throw new AppError(403, "Account is suspended");
  }
  return deliverOtp(user, { onCooldown: "reject" });
}

export async function verifyNumberOtp({ userId, otp }, deviceId) {
  // Checked before the code is used up, so a missing header does not burn the OTP.
  const resolvedDeviceId = requireDeviceId(deviceId);
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (isSuspended(user)) {
    throw new AppError(403, "Account is suspended");
  }

  await verifyOtp({ subjectId: user._id, purpose: OTP_PURPOSE, otp });

  // Signing in during the 30-day window after closing the account restores it.
  const restoring = Boolean(user.deletedAt);
  const updated = await userRepository.updateById(user._id, {
    isNumberVerified: true,
    isActive: true,
    lastLoginAt: new Date(),
    ...(restoring ? { deletedAt: null, deletionReason: null } : {}),
  });
  if (restoring) {
    await publishEventSafe("user.restored", { userId: String(updated._id) }, { aggregate: { type: "user", id: updated._id } });
  }

  const tokens = await issueTokenPair(updated, resolvedDeviceId);
  // First successful sign-in ever. The app uses it (with profileComplete) to
  // decide whether to show Profile Setup.
  const isNewUser = !user.lastLoginAt;
  await publishEventSafe(isNewUser ? "user.first_login" : "user.logged_in", {
    userId: String(updated._id),
    role: updated.role?.slug || null,
  }, { aggregate: { type: "user", id: updated._id } });

  return {
    ...tokens,
    isNewUser,
    profileComplete: Boolean(updated.name && updated.name !== "User"),
    user: toPublicUser(updated),
    message: "Phone number verified successfully",
  };
}

export async function refreshSession({ refreshToken, deviceId }) {
  if (!refreshToken) throw new AppError(401, "Refresh token is required");
  return rotateRefreshToken({ refreshToken, deviceId });
}

export async function logout({ userId, jti, exp, deviceId }) {
  // Revoke the access token first so a missing device header cannot leave it usable.
  await revokeAccessToken({ jti, exp });
  await revokeRefreshToken({ userId, deviceId });
}
