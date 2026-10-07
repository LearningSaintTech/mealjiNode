import mongoose from "mongoose";
import { body, param, query } from "express-validator";
import { AppError } from "./errors/AppError.js";
import { sendSuccess } from "./responses/apiResponse.js";

// Small helpers shared by the Phase 1+ modules so their routes stay short.

export function ok(res, data, message = "OK", status = 200) {
  return sendSuccess(res, { status, message, data });
}

export function paging(source = {}, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(source.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(source.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function pageResult(items, total, { page, limit }) {
  return { items, page, limit, total };
}

export const pageQuery = [
  query("page").optional().isInt({ min: 1 }).withMessage("page must be a positive integer").toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100").toInt(),
];

export const idParam = (name = "id") => param(name).isMongoId().withMessage(`Invalid ${name}`);

export const moneyBody = (name, { optional = false, max = 100_000_000 } = {}) => {
  const chain = body(name);
  return (optional ? chain.optional({ values: "null" }) : chain)
    .isInt({ min: 0, max })
    .withMessage(`${name} must be a whole number of paise`)
    .toInt();
};

export function isObjectId(value) {
  return mongoose.isValidObjectId(value);
}

export function objectId(value, label = "ID") {
  if (!mongoose.isValidObjectId(value)) throw new AppError(400, `Invalid ${label}`);
  return new mongoose.Types.ObjectId(String(value));
}

// The signed-in kitchen user's kitchen; every kitchen.* route acts on it only.
export function ownKitchen(req, res, next) {
  const kitchen = req.auth?.user?.kitchen;
  if (!kitchen) return next(new AppError(404, "This account is not linked to a kitchen"));
  req.kitchenId = String(kitchen._id || kitchen);
  return next();
}

export function requireAnyPermission(...keys) {
  return (req, res, next) => {
    const held = req.auth?.permissions || [];
    if (!keys.some((key) => held.includes(key))) {
      return next(new AppError(403, "You do not have permission to perform this action"));
    }
    return next();
  };
}

export function has(req, key) {
  return (req.auth?.permissions || []).includes(key);
}

export function trimOrNull(value, max = 500) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

export function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * Runs auth only for requests under the given path prefixes. Routers mounted at
 * the API root use it so unknown paths still fall through to a 404.
 */
export function authFor(prefixes, auth) {
  return (req, res, next) => (prefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)) ? auth(req, res, next) : next());
}
