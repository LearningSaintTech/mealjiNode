import { AppError } from "../common/errors/AppError.js";
import { env } from "../config/env.js";
import { redis } from "../config/redis.js";

const UNAVAILABLE = "Service temporarily unavailable. Please try again later.";

const memory = new Map();

function memGet(key) {
  const row = memory.get(key);
  if (!row) return null;
  if (row.expiresAt && Date.now() > row.expiresAt) {
    memory.delete(key);
    return null;
  }
  return row.value;
}

function memSet(key, value, ttlSec) {
  memory.set(key, {
    value: String(value),
    expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : 0,
  });
}

function unavailable(message) {
  // Written for the user (callers pass their own copy), so production shows it.
  return new AppError(503, message || UNAVAILABLE, null, { expose: true });
}

function redisReady() {
  return redis.status === "ready";
}

export async function storeGet(key, { failClosed = true, unavailableMessage } = {}) {
  try {
    if (!redisReady()) throw new Error("redis not ready");
    return await redis.get(key);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (!env.isProd) return memGet(key);
    if (failClosed) throw unavailable(unavailableMessage);
    throw unavailable(unavailableMessage);
  }
}

export async function storeGetOptional(key) {
  try {
    if (!redisReady()) throw new Error("redis not ready");
    return { ok: true, value: await redis.get(key) };
  } catch {
    if (!env.isProd) return { ok: true, value: memGet(key) };
    return { ok: false, value: null };
  }
}

export async function storeSet(key, value, ttlSec, { unavailableMessage } = {}) {
  try {
    if (!redisReady()) throw new Error("redis not ready");
    if (ttlSec) await redis.set(key, value, "EX", ttlSec);
    else await redis.set(key, value);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (!env.isProd) {
      memSet(key, value, ttlSec);
      return;
    }
    throw unavailable(unavailableMessage);
  }
}

// Sets the key only if it does not exist. Returns true when this call created it.
export async function storeSetNx(key, value, ttlSec, { unavailableMessage } = {}) {
  try {
    if (!redisReady()) throw new Error("redis not ready");
    const result = await redis.set(key, value, "EX", ttlSec, "NX");
    return result === "OK";
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (!env.isProd) {
      if (memGet(key) !== null) return false;
      memSet(key, value, ttlSec);
      return true;
    }
    throw unavailable(unavailableMessage);
  }
}

/**
 * A lock owned by one request: returns a token (or null when someone else holds
 * it). Fails closed in production when Redis is down (503), so a double tap can
 * never slip through. Release with releaseLock(key, token).
 */
export async function acquireLock(key, ttlSec) {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return (await storeSetNx(key, token, ttlSec)) ? token : null;
}

const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/** Deletes the lock only if this request still owns it (it may have expired and been taken by another). */
export async function releaseLock(key, token) {
  if (!token) return;
  try {
    if (!redisReady()) throw new Error("redis not ready");
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  } catch {
    if (!env.isProd && memGet(key) === token) memory.delete(key);
  }
}

const RENEW_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end';

/**
 * Extends the lock only if this process still owns it, in one step (a GET then
 * SET could overwrite a lock another process took in between). Returns true when
 * renewed, false when the lock is someone else's (or gone), null when the store
 * can't be reached (keep the current state and try again).
 */
export async function renewLock(key, token, ttlSec) {
  if (!token) return false;
  try {
    if (!redisReady()) throw new Error("redis not ready");
    return Number(await redis.eval(RENEW_SCRIPT, 1, key, token, ttlSec)) === 1;
  } catch {
    if (env.isProd) return null;
    if (memGet(key) !== token) return false;
    memSet(key, token, ttlSec);
    return true;
  }
}

export async function storeDel(...keys) {
  const flat = keys.flat().filter(Boolean);
  if (!flat.length) return;
  try {
    if (!redisReady()) throw new Error("redis not ready");
    await redis.del(...flat);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (!env.isProd) {
      for (const key of flat) memory.delete(key);
      return;
    }
    throw unavailable();
  }
}

export async function storeIncr(key, ttlSec, { unavailableMessage } = {}) {
  try {
    if (!redisReady()) throw new Error("redis not ready");
    const count = await redis.incr(key);
    if (count === 1 && ttlSec) await redis.expire(key, ttlSec);
    return count;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (!env.isProd) {
      const next = Number(memGet(key) || 0) + 1;
      memSet(key, String(next), ttlSec);
      return next;
    }
    throw unavailable(unavailableMessage);
  }
}

export async function storeSadd(key, member, ttlSec, { unavailableMessage } = {}) {
  try {
    if (!redisReady()) throw new Error("redis not ready");
    await redis.sadd(key, member);
    if (ttlSec) await redis.expire(key, ttlSec);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (!env.isProd) {
      const current = memGet(key);
      const set = new Set(current ? JSON.parse(current) : []);
      set.add(String(member));
      memSet(key, JSON.stringify([...set]), ttlSec);
      return;
    }
    throw unavailable(unavailableMessage);
  }
}
