import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { AppError } from "../common/errors/AppError.js";
import { durationToSeconds } from "../common/duration.js";
import { env } from "../config/env.js";

// Key objects built once: building one from the secret string on every
// request showed up in the load-test CPU profile.
let keys = null;
function secretKeys() {
  keys ||= { access: crypto.createSecretKey(Buffer.from(env.accessTokenSecret)), refresh: crypto.createSecretKey(Buffer.from(env.refreshTokenSecret)) };
  return keys;
}

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
    secretKeys().access,
    { expiresIn, jwtid: jti, algorithm: "HS256" },
  );
  return { token, jti, expiresInSec: durationToSeconds(expiresIn) };
}

export function signRefreshToken({ userId, role, deviceId }) {
  assertSecrets();
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { userId: String(userId), role, typ: "refresh", deviceId },
    secretKeys().refresh,
    { expiresIn: env.refreshTokenExpiresIn, jwtid: jti, algorithm: "HS256" },
  );
  return { token, jti, expiresInSec: durationToSeconds(env.refreshTokenExpiresIn) };
}

export function verifyAccessToken(token) {
  assertSecrets();
  const payload = jwt.verify(token, secretKeys().access, { algorithms: ["HS256"] });
  if (payload.typ !== "access" || !payload.jti || !payload.userId) {
    throw new AppError(401, "Invalid or expired token");
  }
  return payload;
}

export function verifyRefreshToken(token) {
  assertSecrets();
  const payload = jwt.verify(token, secretKeys().refresh, { algorithms: ["HS256"] });
  if (payload.typ !== "refresh" || !payload.userId || !payload.deviceId) {
    throw new AppError(401, "Invalid or expired token");
  }
  return payload;
}
