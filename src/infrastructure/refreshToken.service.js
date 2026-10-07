import { AppError } from "../common/errors/AppError.js";
import { requireDeviceId } from "../common/device.util.js";
import { timingSafeEqualString } from "../common/timingSafe.js";
import { env } from "../config/env.js";
import { userRepository } from "../modules/user/user.repository.js";
import { isSuspended, tokenRevoked } from "../modules/user/user.status.js";
import { denyAccessJti } from "./accessTokenDenylist.service.js";
import { storeDel, storeGetOptional, storeSet, storeSetNx } from "./redisStore.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./token.service.js";

const refreshKey = (userId, deviceId) => `refreshtoken:${userId}:${deviceId}`;
const previousKey = (userId, deviceId) => `refreshtoken:prev:${userId}:${deviceId}`;
const rotateLockKey = (userId, deviceId) => `refreshtoken:lock:${userId}:${deviceId}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function issueTokenPair(user, deviceId) {
  const role = user.role?.slug;
  if (!role) throw new AppError(500, "User role is missing");

  const resolvedDeviceId = requireDeviceId(deviceId);
  const access = signAccessToken({ userId: user._id, role });

  const refresh = signRefreshToken({ userId: user._id, role, deviceId: resolvedDeviceId });
  await storeSet(refreshKey(user._id, resolvedDeviceId), refresh.token, refresh.expiresInSec);

  return {
    userId: String(user._id),
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresInSec,
  };
}

export async function rotateRefreshToken({ refreshToken, deviceId }) {
  const resolvedDeviceId = requireDeviceId(deviceId);
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "Invalid or expired token");
  }

  const user = await userRepository.findById(payload.userId);
  if (!user || !user.isActive || !user.isNumberVerified || isSuspended(user) || tokenRevoked(user, payload.iat) || payload.deviceId !== resolvedDeviceId) {
    throw new AppError(401, "Invalid or expired token");
  }

  // Two refreshes with the same token at once (e.g. two tabs) must not both
  // rotate: the second waits briefly and then takes the grace path below.
  const locked = await storeSetNx(rotateLockKey(user._id, resolvedDeviceId), "1", 5).catch(() => true);
  if (!locked) await sleep(400);

  const current = await storeGetOptional(refreshKey(user._id, resolvedDeviceId));
  if (!current.ok) {
    throw new AppError(503, "Service temporarily unavailable. Please try again later.");
  }

  const previous = await storeGetOptional(previousKey(user._id, resolvedDeviceId));
  const matchesCurrent = Boolean(current.value) && timingSafeEqualString(current.value, refreshToken);
  const matchesPrevious = Boolean(previous.ok && previous.value) && timingSafeEqualString(previous.value, refreshToken);

  if (matchesCurrent) {
    const refresh = signRefreshToken({ userId: user._id, role: user.role.slug, deviceId: resolvedDeviceId });
    await storeSet(previousKey(user._id, resolvedDeviceId), current.value, env.refreshTokenGraceSec);
    await storeSet(refreshKey(user._id, resolvedDeviceId), refresh.token, refresh.expiresInSec);
    await storeDel(rotateLockKey(user._id, resolvedDeviceId)).catch(() => {});
    const access = signAccessToken({ userId: user._id, role: user.role.slug });
    return {
      userId: String(user._id),
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresInSec,
    };
  }

  if (!previous.ok) {
    throw new AppError(503, "Service temporarily unavailable. Please try again later.");
  }

  if (matchesPrevious && current.value) {
    const access = signAccessToken({ userId: user._id, role: user.role.slug });
    return {
      userId: String(user._id),
      accessToken: access.token,
      refreshToken: current.value,
      expiresIn: access.expiresInSec,
    };
  }

  await storeDel(refreshKey(user._id, resolvedDeviceId), previousKey(user._id, resolvedDeviceId));
  throw new AppError(401, "Invalid or expired token");
}

export async function revokeRefreshToken({ userId, deviceId }) {
  const resolvedDeviceId = requireDeviceId(deviceId);
  await storeDel(
    refreshKey(userId, resolvedDeviceId),
    previousKey(userId, resolvedDeviceId),
  );
}

export async function revokeAccessToken({ jti, exp }) {
  await denyAccessJti({ jti, exp });
}
