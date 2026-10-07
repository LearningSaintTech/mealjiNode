import { body, param, query } from "express-validator";

const time = (field) => body(field)
  .trim()
  .matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  .withMessage(`${field} must be HH:mm`);

const KITCHEN_STATUSES = ["onboarding", "active", "paused"];

const pinPair = body("longitude").custom((value, { req }) => {
  const hasLatitude = req.body.latitude !== undefined && req.body.latitude !== null && req.body.latitude !== "";
  const hasLongitude = value !== undefined && value !== null && value !== "";
  if (hasLatitude !== hasLongitude) throw new Error("Latitude and longitude are both required");
  return true;
});

const distinctHours = body("closesAt").custom((value, { req }) => {
  if (value && value === req.body.opensAt) throw new Error("Closing time must differ from opening time");
  return true;
});

const kitchenFields = [
  body("name").trim().notEmpty().withMessage("Kitchen name is required").isLength({ max: 80 }).withMessage("Kitchen name is too long"),
  body("contactName").trim().notEmpty().withMessage("Contact name is required").isLength({ max: 80 }).withMessage("Contact name is too long"),
  body("countryCode").optional({ values: "falsy" }).matches(/^\+\d{1,3}$/).withMessage("Invalid country code"),
  body("phoneNumber").trim().matches(/^[6-9]\d{9}$/).withMessage("Invalid phone number format"),
  body("addressLine").trim().notEmpty().withMessage("Address is required").isLength({ max: 160 }).withMessage("Address is too long"),
  body("area").optional({ values: "falsy" }).trim().isLength({ max: 80 }).withMessage("Area is too long"),
  body("city").trim().notEmpty().withMessage("City is required").isLength({ max: 60 }).withMessage("City is too long"),
  body("state").optional({ values: "falsy" }).trim().isLength({ max: 60 }).withMessage("State is too long"),
  body("postalCode").optional({ values: "falsy" }).trim().matches(/^\d{6}$/).withMessage("Postal code must be 6 digits"),
  body("latitude").optional({ values: "null" }).isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude").toFloat(),
  body("longitude").optional({ values: "null" }).isFloat({ min: -180, max: 180 }).withMessage("Invalid longitude").toFloat(),
  pinPair,
  body("serviceRadiusKm").isFloat({ min: 0.5, max: 25 }).withMessage("Service radius must be between 0.5 and 25 km").toFloat(),
  time("opensAt"),
  time("closesAt"),
  distinctHours,
  body("serviceNote").optional({ values: "falsy" }).trim().isLength({ max: 280 }).withMessage("Service note is too long"),
];

export const onboardKitchenValidation = [
  ...kitchenFields,
  body("status").optional({ values: "falsy" }).isIn(KITCHEN_STATUSES).withMessage("Invalid kitchen status"),
];

export const updateKitchenValidation = [
  param("kitchenId").isMongoId().withMessage("Invalid kitchen ID"),
  ...kitchenFields,
  body("status").isIn(KITCHEN_STATUSES).withMessage("Invalid kitchen status"),
];

export const listKitchensValidation = [
  query("page").optional().isInt({ min: 1 }).withMessage("page must be a positive integer").toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100").toInt(),
  query("status").optional({ values: "falsy" }).isIn(KITCHEN_STATUSES).withMessage("Invalid kitchen status"),
  query("phone").optional().trim().matches(/^\d{1,15}$/).withMessage("Invalid phone search"),
  query("q").optional().trim().isLength({ max: 40 }).withMessage("Search is too long"),
];

export const kitchenIdParam = [
  param("kitchenId").isMongoId().withMessage("Invalid kitchen ID"),
];

export const configureKitchenValidation = [
  body("name").trim().notEmpty().withMessage("Kitchen name is required").isLength({ max: 80 }).withMessage("Kitchen name is too long"),
  body("contactName").trim().notEmpty().withMessage("Contact name is required").isLength({ max: 80 }).withMessage("Contact name is too long"),
  body("addressLine").trim().notEmpty().withMessage("Address is required").isLength({ max: 160 }).withMessage("Address is too long"),
  body("area").optional({ values: "falsy" }).trim().isLength({ max: 80 }).withMessage("Area is too long"),
  body("city").trim().notEmpty().withMessage("City is required").isLength({ max: 60 }).withMessage("City is too long"),
  body("state").optional({ values: "falsy" }).trim().isLength({ max: 60 }).withMessage("State is too long"),
  body("postalCode").optional({ values: "falsy" }).trim().matches(/^\d{6}$/).withMessage("Postal code must be 6 digits"),
  body("latitude").optional({ values: "null" }).isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude").toFloat(),
  body("longitude").optional({ values: "null" }).isFloat({ min: -180, max: 180 }).withMessage("Invalid longitude").toFloat(),
  pinPair,
  time("opensAt"),
  time("closesAt"),
  distinctHours,
  body("serviceNote").optional({ values: "falsy" }).trim().isLength({ max: 280 }).withMessage("Service note is too long"),
];

export const placeSearchValidation = [
  query("q").trim().isLength({ min: 3, max: 120 }).withMessage("Enter at least 3 characters to search"),
];

export const inviteKitchenStaffValidation = [
  body("name").trim().notEmpty().withMessage("Name is required").isLength({ max: 80 }).withMessage("Name is too long"),
  body("countryCode").optional({ values: "falsy" }).matches(/^\+\d{1,3}$/).withMessage("Invalid country code"),
  body("phoneNumber").trim().matches(/^[6-9]\d{9}$/).withMessage("Invalid phone number format"),
  body("roleSlug").optional({ values: "falsy" }).matches(/^kitchen_[a-z0-9_]+$/).withMessage("Invalid role"),
];

export const kitchenStaffStatusValidation = [
  param("userId").isMongoId().withMessage("Invalid user ID"),
  body("isActive").custom((value) => {
    if (typeof value !== "boolean") throw new Error("isActive must be a boolean");
    return true;
  }),
];

export const serviceValidation = [
  body("acceptingOrders").custom((value) => {
    if (typeof value !== "boolean") throw new Error("acceptingOrders must be a boolean");
    return true;
  }),
];

export const kitchenStatusValidation = [
  ...kitchenIdParam,
  body("status").isIn(KITCHEN_STATUSES).withMessage("Invalid kitchen status"),
];
