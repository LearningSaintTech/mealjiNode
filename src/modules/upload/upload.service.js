import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../common/errors/AppError.js";
import { env, rootDir } from "../../config/env.js";
import { presignS3Put } from "../../infrastructure/awsSigV4.js";

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
  if (env.storageDriver === "s3") {
    return env.cdnBaseUrl ? `${env.cdnBaseUrl}/${key}` : `https://${env.s3Bucket}.s3.${env.s3Region}.amazonaws.com/${key}`;
  }
  return `${env.publicBaseUrl}/files/${key}`;
}

export function presignUpload({ purpose, contentType, size, ownerId }) {
  const rule = UPLOAD_PURPOSES[purpose];
  if (!rule) throw new AppError(422, "Unknown upload purpose");
  if (!rule.types.includes(contentType)) throw new AppError(422, `Allowed file types: ${rule.types.join(", ")}`);
  if (!Number.isInteger(size) || size <= 0 || size > rule.maxBytes) {
    throw new AppError(422, `File must be under ${Math.round(rule.maxBytes / 1024 / 1024)} MB`);
  }
  const key = `${purpose}/${String(ownerId || "anon")}/${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}.${EXT[contentType]}`;
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
  const allowed = [publicUrl(""), env.cdnBaseUrl ? `${env.cdnBaseUrl}/` : null].filter(Boolean);
  if (!env.isProd && /^https?:\/\//.test(value)) return value;
  if (!allowed.some((prefix) => value.startsWith(prefix))) throw new AppError(422, `${label} must be uploaded through MealJi`);
  return value;
}
