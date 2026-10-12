import { indianMobileDigits } from "../../common/phone.util.js";
import { Router } from "express";
import { body } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { otpRateLimiter } from "../../infrastructure/rateLimit.js";
import * as profile from "./profile.service.js";

const router = Router();
router.use(authFor(["/me"], authMiddleware));

router.get("/me", asyncHandler(async (req, res) => ok(res, await profile.getProfile(req.auth.userId, { user: req.auth.user }), "Profile fetched.")));

router.patch(
  "/me",
  body("name").optional().isString().trim().isLength({ min: 2, max: 80 }).withMessage("Please enter your full name (min 2 characters)"),
  body("email").optional({ values: "null" }).isEmail().withMessage("Enter a valid email address").isLength({ max: 120 }),
  body("dob").optional({ values: "null" }).isISO8601({ strict: true }).withMessage("Enter a valid date of birth").custom((value) => {
    if (value && new Date(value) > new Date()) throw new Error("Date of birth cannot be in the future");
    return true;
  }),
  // The app shows "Male", "Female", "Other", "Prefer not to say".
  body("gender").optional({ values: "null" }).customSanitizer((value) => (typeof value === "string" ? ({ "prefer not to say": "prefer_not" }[value.trim().toLowerCase()] || value.trim().toLowerCase()) : value))
    .isIn(["male", "female", "other", "prefer_not"]).withMessage("Choose Male, Female, Other or Prefer not to say"),
  body("avatarUrl").optional({ values: "null" }).isURL({ require_tld: false }).withMessage("Choose a photo"),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.updateProfile(req.auth.userId, req.body), "Profile updated.")),
);

// Avatar: upload through POST /uploads/presign (purpose "avatar"), then save the URL here.
router.post(
  "/me/avatar",
  body("avatarUrl").isURL({ require_tld: false }).withMessage("Choose a photo"),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.updateProfile(req.auth.userId, { avatarUrl: req.body.avatarUrl }), "Avatar updated.")),
);

router.get("/me/preferences", asyncHandler(async (req, res) => ok(res, await profile.getPreferences(req.auth.userId, { user: req.auth.user }), "Preferences fetched.")));
router.patch(
  "/me/preferences",
  body("language").optional().isIn(["en", "hi"]).withMessage("Choose English or Hindi"),
  body("vegOnly").optional().isBoolean().toBoolean(true),
  body("channels").optional().isObject(),
  body("topics").optional().isObject(),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.updatePreferences(req.auth.userId, req.body, { ip: req.ip, deviceId: req.headers["x-device-id"] || null }), "Preferences saved.")),
);

router.post(
  "/me/phone/otp",
  body("countryCode").optional().matches(/^\+\d{1,3}$/),
  // Same formats as sign-in: “98765 43210”, “+91 98765 43210”, “098765-43210”.
  body("phoneNumber").customSanitizer(indianMobileDigits).matches(/^[6-9]\d{9}$/).withMessage("Enter a valid 10-digit mobile number"),
  validate,
  otpRateLimiter,
  asyncHandler(async (req, res) => ok(res, await profile.requestPhoneChange(req.auth.userId, req.body), "OTP sent to the new number.")),
);
router.post(
  "/me/phone/verify",
  body("countryCode").optional().matches(/^\+\d{1,3}$/),
  // Same formats as sign-in: “98765 43210”, “+91 98765 43210”, “098765-43210”.
  body("phoneNumber").customSanitizer(indianMobileDigits).matches(/^[6-9]\d{9}$/).withMessage("Enter a valid 10-digit mobile number"),
  body("otp").matches(/^\d{4,6}$/).withMessage("Enter the 6-digit code we sent"),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.confirmPhoneChange(req.auth.userId, req.body, req.auth), "Phone number changed. Please sign in again.")),
);

router.get("/me/data-export", asyncHandler(async (req, res) => ok(res, await profile.exportData(req.auth.userId), "Your data.")));
router.delete(
  "/me",
  body("reason").optional({ values: "null" }).isString().isLength({ max: 300 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.deleteAccount(req.auth.userId, req.body || {}), "Account closed. Sign in within 30 days to restore it.")),
);

export default router;
