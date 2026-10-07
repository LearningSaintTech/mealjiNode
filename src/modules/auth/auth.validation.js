import { body } from "express-validator";

const phone = body("phoneNumber")
  .trim()
  .notEmpty()
  .withMessage("Phone number is required")
  .matches(/^[6-9]\d{9}$/)
  .withMessage("Invalid phone number format");

const countryCode = body("countryCode")
  .optional()
  .matches(/^\+\d{1,3}$/)
  .withMessage("Invalid country code");

export const loginValidation = [
  body("name")
    .optional({ values: "falsy" })
    .trim()
    .isLength({ max: 80 })
    .withMessage("Name is too long"),
  countryCode,
  phone,
];

export const staffLoginValidation = [countryCode, phone];

export const verifyOtpValidation = [
  body("userId").notEmpty().withMessage("User ID is required").isMongoId().withMessage("Invalid user ID"),
  body("otp")
    .trim()
    .notEmpty()
    .withMessage("OTP is required")
    .isLength({ min: 4, max: 6 })
    .withMessage("OTP must be 4 to 6 digits")
    .matches(/^\d+$/)
    .withMessage("OTP must be numeric"),
  body("deviceId").optional().isString().isLength({ max: 80 }).withMessage("deviceId is too long"),
];

export const resendOtpValidation = [
  body("userId").notEmpty().withMessage("User ID is required").isMongoId().withMessage("Invalid user ID"),
];
