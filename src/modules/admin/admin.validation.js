import { body, param, query } from "express-validator";
const SLUG = /^[a-z][a-z0-9_]{1,60}$/;

export const createStaffValidation = [
  body("name")
    .trim()
    .notEmpty()
    .withMessage("Name is required")
    .isLength({ max: 80 })
    .withMessage("Name is too long"),
  body("countryCode").optional().matches(/^\+\d{1,3}$/).withMessage("Invalid country code"),
  body("phoneNumber")
    .trim()
    .notEmpty()
    .withMessage("Phone number is required")
    .matches(/^[6-9]\d{9}$/)
    .withMessage("Invalid phone number format"),
  body("roleSlug")
    .trim()
    .notEmpty()
    .withMessage("Role is required")
    .matches(SLUG)
    .withMessage("Invalid role"),
];

export const listUsersValidation = [
  query("page").optional().isInt({ min: 1 }).withMessage("page must be a positive integer").toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100").toInt(),
  query("role").optional({ values: "falsy" }).matches(SLUG).withMessage("Invalid role"),
  query("status").optional({ values: "falsy" }).isIn(["active", "suspended", "invited"]).withMessage("Invalid status"),
  query("kitchenId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid kitchen ID"),
  query("phone").optional().trim().matches(/^\d{1,15}$/).withMessage("Invalid phone search"),
  query("q").optional().trim().isLength({ max: 40 }).withMessage("Search is too long"),
];

export const userIdParam = [
  param("userId").isMongoId().withMessage("Invalid user ID"),
];

export const updateStatusValidation = [
  ...userIdParam,
  body("isActive").custom((value) => {
    if (typeof value !== "boolean") throw new Error("isActive must be a boolean");
    return true;
  }),
];

export const roleSlugParam = [
  param("slug").matches(SLUG).withMessage("Invalid role"),
];

export const updateRolePermissionsValidation = [
  ...roleSlugParam,
  body("permissions").isArray({ max: 100 }).withMessage("permissions must be an array of keys"),
  body("permissions.*").isString().matches(/^[a-z_]+(\.[a-z_]+)+$/).withMessage("Invalid permission key"),
];

export const createRoleValidation = [
  body("name").trim().isLength({ min: 2, max: 60 }).withMessage("Name must be 2 to 60 characters"),
  body("description").optional().trim().isLength({ max: 200 }).withMessage("Description is too long"),
  body("scope").isIn(["platform", "kitchen"]).withMessage("scope must be platform or kitchen"),
  body("kitchenId").optional({ values: "null" }).isMongoId().withMessage("Invalid kitchen ID"),
  body("permissions").isArray({ max: 100 }).withMessage("permissions must be an array of keys"),
  body("permissions.*").isString().matches(/^[a-z_]+(\.[a-z_]+)+$/).withMessage("Invalid permission key"),
];

export const updateRoleMetaValidation = [
  ...roleSlugParam,
  body("name").optional().trim().isLength({ min: 2, max: 60 }).withMessage("Name must be 2 to 60 characters"),
  body("description").optional().trim().isLength({ max: 200 }).withMessage("Description is too long"),
];

export const updateRoleValidation = [
  ...userIdParam,
  body("roleSlug").trim().matches(SLUG).withMessage("Invalid role"),
];
