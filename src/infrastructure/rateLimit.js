import { AppError } from "../common/errors/AppError.js";
import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error("timeout");
        error.name = "RedisTimeout";
        reject(error);
      }, ms);
    }),
  ]);
}

export async function checkRateLimit({ key, limit, windowSec }) {
  if (!env.isProd && redis.status !== "ready") return;

  try {
    if (redis.status !== "ready") {
      const error = new Error("redis not ready");
      error.name = "RedisTimeout";
      throw error;
    }

    const count = await withTimeout(redis.incr(key), env.rateLimitRedisTimeoutMs);
    if (count === 1) {
      await withTimeout(redis.expire(key, windowSec), env.rateLimitRedisTimeoutMs).catch(() => {});
    }
    if (count > limit) {
      throw new AppError(429, "Too many requests. Please try again later.");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (env.isProd) {
      throw new AppError(503, "Service temporarily unavailable. Please try again later.");
    }
  }
}

function clientIp(req) {
  return String(req.ip || "unknown");
}

function deviceId(req) {
  return String(req.headers["x-device-id"] || req.body?.deviceId || "").trim().slice(0, 80);
}

// Keyed on the last 10 digits only: the account lookup and the SMS ignore the
// country code, so varying it must not open a fresh bucket for the same phone.
function phoneKey(req) {
  const phone = String(req.body?.phoneNumber || "").replace(/\D/g, "").slice(-10);
  return phone;
}

function subjectKey(prefix, req) {
  const phone = phoneKey(req);
  if (phone) return `rate:${prefix}:phone:${phone}`;
  const device = deviceId(req);
  if (device) return `rate:${prefix}:device:${device}`;
  return `rate:${prefix}:ip:${clientIp(req)}`;
}

function limiter({ prefix, limit, windowSec, keyFn }) {
  return async (req, res, next) => {
    try {
      await checkRateLimit({
        key: `rate:${prefix}:ip-ceiling:${clientIp(req)}`,
        limit: env.otpIpSoftLimit,
        windowSec: env.otpIpSoftWindowSec,
      });
      await checkRateLimit({
        key: keyFn(req),
        limit,
        windowSec,
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const otpRateLimiter = limiter({
  prefix: "otp",
  limit: env.otpRateLimit,
  windowSec: env.otpRateWindowSec,
  keyFn: (req) => subjectKey("otp", req),
});

export const loginRateLimiter = limiter({
  prefix: "login",
  limit: env.loginRateLimit,
  windowSec: env.loginRateWindowSec,
  keyFn: (req) => subjectKey("login", req),
});

export const verifyOtpRateLimiter = limiter({
  prefix: "verify-otp",
  limit: env.verifyOtpRateLimit,
  windowSec: env.verifyOtpRateWindowSec,
  keyFn: (req) => (
    req.body?.userId
      ? `rate:verify-otp:user:${String(req.body.userId).toLowerCase()}`
      : subjectKey("verify-otp", req)
  ),
});

export const refreshTokenRateLimiter = limiter({
  prefix: "refresh",
  limit: env.refreshRateLimit,
  windowSec: env.refreshRateWindowSec,
  keyFn: (req) => subjectKey("refresh", req),
});

export async function placeSearchLimiter(req, res, next) {
  try {
    await checkRateLimit({
      key: `rate:places:user:${req.auth?.userId || "unknown"}`,
      limit: 40,
      windowSec: 3600,
    });
    next();
  } catch (err) {
    next(err);
  }
}

export async function locationRateLimiter(req, res, next) {
  try {
    await checkRateLimit({
      key: `rate:location:user:${req.auth?.userId || "unknown"}`,
      limit: env.locationRateLimit,
      windowSec: env.locationRateWindowSec,
    });
    next();
  } catch (err) {
    next(err);
  }
}

// Per-account limiter for signed-in write endpoints (cart, search, ingest…).
export function accountLimiter(prefix, { limit, windowSec }) {
  return async (req, res, next) => {
    try {
      const subject = req.auth?.userId || deviceId(req) || clientIp(req);
      await checkRateLimit({ key: `rate:${prefix}:${subject}`, limit, windowSec });
      next();
    } catch (err) {
      next(err);
    }
  };
}
