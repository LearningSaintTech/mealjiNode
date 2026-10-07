import { body, param, query } from "express-validator";

const key = param("key").matches(/^[a-z_]{2,40}$/).withMessage("Invalid setting key");

export const settingKeyParam = [key];

export const getSettingValidation = [
  key,
  query("scopeType").optional({ values: "falsy" }).isIn(["global", "city", "kitchen"]).withMessage("Invalid scope"),
  query("scopeId").optional({ values: "falsy" }).trim().isLength({ max: 80 }).withMessage("Invalid scope ID"),
];

export const updateSettingValidation = [
  key,
  body("scopeType").optional({ values: "falsy" }).isIn(["global", "city", "kitchen"]).withMessage("Invalid scope"),
  body("scopeId").optional({ values: "falsy" }).isString().trim().isLength({ max: 80 }).withMessage("Invalid scope ID"),
  body("values").custom((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("values must be an object");
    return true;
  }),
  body("effectiveFrom").optional({ values: "null" }).isISO8601().withMessage("effectiveFrom must be an ISO date"),
  body("reason").optional({ values: "null" }).isString().isLength({ max: 500 }).withMessage("Reason is too long"),
];

export const setLimitsValidation = [
  key,
  body("fields").custom((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fields must be an object");
    return true;
  }),
];

export const cancelScheduledValidation = [
  key,
  param("version").isInt({ min: 1 }).withMessage("Invalid version").toInt(),
  query("scopeType").optional({ values: "falsy" }).isIn(["global", "city", "kitchen"]).withMessage("Invalid scope"),
  query("scopeId").optional({ values: "falsy" }).trim().isLength({ max: 80 }).withMessage("Invalid scope ID"),
];

export const kitchenUpdateSettingValidation = [
  key,
  body("values").custom((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("values must be an object");
    return true;
  }),
  body("reason").optional({ values: "null" }).isString().isLength({ max: 500 }).withMessage("Reason is too long"),
];
