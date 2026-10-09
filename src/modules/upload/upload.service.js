import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../common/errors/AppError.js";
import { env, rootDir } from "../../config/env.js";
import { presignS3, presignS3Put } from "../../infrastructure/awsSigV4.js";

// Uploads go straight from the client to storage: the API hands out a
// short-lived, single-purpose upload URL and the final public URL.

export const UPLOAD_PURPOSES = {
  avatar: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 2 * 1024 * 1024 },
  dish: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024 },
  banner: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024 },
  kitchen: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024 },
  content: { types: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"], maxBytes: 5 * 1024 * 1024 },
  ticket: { types: ["image/jpeg", "image/png", "image/webp", "application/pdf"], maxBytes: 5 * 1024 * 1024 },
  import: { types: ["text/csv"], maxBytes: 10 * 1024 * 1024 },
};

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/svg+xml": "svg", "application/pdf": "pdf", "text/csv": "csv" };
export const LOCAL_DIR = path.join(rootDir, "uploads");

function token(key, contentType, expiresAt) {
  return crypto.createHmac("sha256", env.storageSecret).update(`${key}|${contentType}|${expiresAt}`).digest("hex");
}

export function publicUrl(key) {
  if (env.storageDriver === "s3" && env.cdnBaseUrl) return `${env.cdnBaseUrl}/${key}`;
  return `${env.publicBaseUrl}/files/${key}`;
}

/** The storage key for a path inside MealJi's folder (S3_KEY_PREFIX on S3). */
export function storageKey(relativeKey) {
  return env.storageDriver === "s3" && env.s3KeyPrefix ? `${env.s3KeyPrefix}/${relativeKey}` : relativeKey;
}

/** A short-lived link that serves a stored file (the /files route on S3 without a CDN). */
export function signedFileUrl(key, expiresSec = 3600) {
  if (key.includes("..")) throw new AppError(400, "Invalid key");
  if (env.s3KeyPrefix && !key.startsWith(`${env.s3KeyPrefix}/`)) throw new AppError(404, "Not found");
  return presignS3({ method: "GET", key, expiresSec });
}

/**
 * Server-side upload (seed data, imports): stores `body` at `key` unless an
 * object is already there. Returns the public URL.
 */
export async function putFile(key, body, contentType, { overwrite = false } = {}) {
  if (env.storageDriver === "s3") {
    if (!overwrite) {
      const head = await fetch(presignS3({ method: "HEAD", key, expiresSec: 120 }), { method: "HEAD" });
      if (head.ok) return publicUrl(key);
    }
    const res = await fetch(presignS3Put({ key, contentType, expiresSec: 600 }), { method: "PUT", headers: { "Content-Type": contentType }, body });
    if (!res.ok) throw new AppError(502, `Storage upload failed (${res.status}) for ${key}`);
    return publicUrl(key);
  }
  const target = path.join(LOCAL_DIR, ...key.split("/"));
  if (!overwrite && await fs.stat(target).then(() => true, () => false)) return publicUrl(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return publicUrl(key);
}

export function presignUpload({ purpose, contentType, size, ownerId }) {
  const rule = UPLOAD_PURPOSES[purpose];
  if (!rule) throw new AppError(422, "Unknown upload purpose");
  if (!rule.types.includes(contentType)) throw new AppError(422, `Allowed file types: ${rule.types.join(", ")}`);
  if (!Number.isInteger(size) || size <= 0 || size > rule.maxBytes) {
    throw new AppError(422, `File must be under ${Math.round(rule.maxBytes / 1024 / 1024)} MB`);
  }
  const key = storageKey(`${purpose}/${String(ownerId || "anon")}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${EXT[contentType]}`);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const uploadUrl = env.storageDriver === "s3"
    ? presignS3Put({ key, contentType, expiresSec: 600 })
    : `${env.publicBaseUrl}/api/v1/uploads/local/${key}?expires=${expiresAt}&token=${token(key, contentType, expiresAt)}`;
  return {
    key,
    method: "PUT",
    uploadUrl,
    headers: { "Content-Type": contentType },
    fileUrl: publicUrl(key),
    maxBytes: rule.maxBytes,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

// Development driver: stores the PUT body after checking the signed token.
export async function storeLocalUpload({ key, contentType, expires, providedToken, body }) {
  if (env.storageDriver !== "local") throw new AppError(404, "Not found");
  const expiresAt = Number(expires);
  if (!expiresAt || expiresAt < Date.now()) throw new AppError(403, "This upload link has expired");
  const expected = token(key, contentType, expiresAt);
  if (!providedToken || providedToken.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(expected))) {
    throw new AppError(403, "Invalid upload link");
  }
  const purpose = key.split("/")[0];
  const rule = UPLOAD_PURPOSES[purpose];
  if (!rule || !Buffer.isBuffer(body) || !body.length || body.length > rule.maxBytes) throw new AppError(422, "Invalid file");
  if (key.includes("..")) throw new AppError(400, "Invalid key");
  const target = path.join(LOCAL_DIR, ...key.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
  return { key, fileUrl: publicUrl(key), bytes: body.length };
}

// Accepts only URLs this storage produced (or empty), so records never point at arbitrary hosts.
export function assertOwnFileUrl(url, label = "Image") {
  if (url == null || url === "") return null;
  const value = String(url);
  // Our storage, our CDN, or the hosted demo seed images — never another site, in any environment.
  const allowed = [publicUrl(""), env.cdnBaseUrl ? `${env.cdnBaseUrl}/` : null, env.seedImageBaseUrl ? `${env.seedImageBaseUrl}/` : null].filter(Boolean);
  if (!allowed.some((prefix) => value.startsWith(prefix))) throw new AppError(422, `${label} must be uploaded through MealJi`);
  return value;
}
