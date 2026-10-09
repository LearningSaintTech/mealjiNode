import { body } from "express-validator";

// People type "98765 43210", "+91 98765 43210", "098765-43210": keep the
// 10 digits. An email gets a clear "use your mobile number" (sign-in is OTP).
const phone = body("phoneNumber")
  .trim()
  .notEmpty()
  .withMessage("Enter your mobile number")
  .bail()
  .custom((value) => {
    if (String(value).includes("@")) throw new Error("Sign in with your 10-digit mobile number; email sign-in is not available");
    return true;
  })
  .bail()
  .customSanitizer((value) => {
    let digits = String(value).replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return digits;
  })
  .matches(/^[6-9]\d{9}$/)
  .withMessage("Enter a valid 10-digit mobile number");

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
