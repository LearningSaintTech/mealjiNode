import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { AppError } from "../common/errors/AppError.js";
import { durationToSeconds } from "../common/duration.js";
import { env } from "../config/env.js";

function assertSecrets() {
  if (!env.accessTokenSecret || !env.refreshTokenSecret) {
    throw new AppError(500, "Token secrets are not configured");
  }
}

export function signAccessToken({ userId, role }) {
  assertSecrets();
  const jti = crypto.randomUUID();
  const expiresIn = env.accessTokenExpiresIn;
  const token = jwt.sign(
    { userId: String(userId), role, typ: "access" },
    env.accessTokenSecret,
    { expiresIn, jwtid: jti },
  );
  return { token, jti, expiresInSec: durationToSeconds(expiresIn) };
}

export function signRefreshToken({ userId, role, deviceId }) {
  assertSecrets();
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { userId: String(userId), role, typ: "refresh", deviceId },
    env.refreshTokenSecret,
    { expiresIn: env.refreshTokenExpiresIn, jwtid: jti },
  );
  return { token, jti, expiresInSec: durationToSeconds(env.refreshTokenExpiresIn) };
}

export function verifyAccessToken(token) {
  assertSecrets();
  const payload = jwt.verify(token, env.accessTokenSecret);
  if (payload.typ !== "access" || !payload.jti || !payload.userId) {
    throw new AppError(401, "Invalid or expired token");
  }
  return payload;
}

export function verifyRefreshToken(token) {
  assertSecrets();
  const payload = jwt.verify(token, env.refreshTokenSecret);
  if (payload.typ !== "refresh" || !payload.userId || !payload.deviceId) {
    throw new AppError(401, "Invalid or expired token");
  }
  return payload;
}
