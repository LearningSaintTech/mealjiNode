import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { storeDel, storeGet, storeSet, storeSetNx } from "../../infrastructure/redisStore.js";
import { AppError } from "../errors/AppError.js";

const KEY_PATTERN = /^[\w-]{8,128}$/;
const PENDING = "pending";
// Long enough for any create request (geocoding, payment calls) to finish.
const LOCK_TTL_SEC = 300;

// Key order does not matter: {a,b} and {b,a} are the same request.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function bodyHash(body) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(body ?? {}))).digest("hex");
}

/**
 * Makes a create endpoint safe to retry. The client sends `Idempotency-Key`; a
 * repeat with the same key and body replays the first response instead of
 * creating twice. With `required: false` (default) requests without the header
 * pass through unchanged, so existing clients keep working.
 */
export function idempotent({ required = false } = {}) {
  return async (req, res, next) => {
    try {
      const key = String(req.headers["idempotency-key"] || "").trim();
      if (!key) {
        if (required) throw new AppError(400, "Idempotency-Key header is required");
        return next();
      }
      if (!KEY_PATTERN.test(key)) {
        throw new AppError(400, "Idempotency-Key must be 8 to 128 letters, digits, '_' or '-'");
      }

      const owner = req.auth?.userId || String(req.headers["x-device-id"] || "anonymous");
      const storeKey = `idem:${owner}:${req.method}:${req.baseUrl}${req.path}:${key}`;
      const hash = bodyHash(req.body);

      let acquired;
      try {
        acquired = await storeSetNx(storeKey, PENDING, LOCK_TTL_SEC);
      } catch (err) {
        // The header is optional here: without the store, behave as if it was not sent.
        if (!required) return next();
        throw err;
      }
      if (!acquired) {
        const stored = await storeGet(storeKey);
        if (!stored || stored === PENDING) {
          throw new AppError(409, "A request with this Idempotency-Key is still being processed");
        }
        const previous = JSON.parse(stored);
        if (previous.hash !== hash) {
          throw new AppError(422, "Idempotency-Key was already used with a different request body");
        }
        res.setHeader("Idempotent-Replayed", "true");
        return res.status(previous.status).json(previous.body);
      }

      let stored = false;
      const send = res.json.bind(res);
      res.json = (body) => {
        stored = true;
        const status = res.statusCode;
        // Server errors release the key so the client can retry; everything else is final.
        const done = status >= 500
          ? storeDel(storeKey)
          : storeSet(storeKey, JSON.stringify({ status, hash, body }), env.idempotencyTtlSec);
        done.catch((err) => req.log?.warn({ err: err.message }, "Could not store idempotent response"));
        return send(body);
      };
      // A response that did not go through res.json (or a dropped connection)
      // releases the key instead of leaving it pending.
      res.on("close", () => {
        if (!stored) storeDel(storeKey).catch(() => {});
      });
      next();
    } catch (err) {
      next(err);
    }
  };
}
