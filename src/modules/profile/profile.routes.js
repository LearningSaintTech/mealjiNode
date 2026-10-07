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

router.get("/me", asyncHandler(async (req, res) => ok(res, await profile.getProfile(req.auth.userId), "Profile fetched.")));

router.patch(
  "/me",
  body("name").optional().isString().trim().isLength({ min: 1, max: 80 }).withMessage("Name must be 1 to 80 characters"),
  body("email").optional({ values: "null" }).isEmail().withMessage("Invalid email").isLength({ max: 120 }),
  body("dob").optional({ values: "null" }).isISO8601({ strict: true }).withMessage("dob must be YYYY-MM-DD").custom((value) => {
    if (value && new Date(value) > new Date()) throw new Error("dob cannot be in the future");
    return true;
  }),
  body("gender").optional({ values: "null" }).isIn(["male", "female", "other", "prefer_not"]).withMessage("Invalid gender"),
  body("avatarUrl").optional({ values: "null" }).isURL({ require_tld: false }).withMessage("Invalid avatar URL"),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.updateProfile(req.auth.userId, req.body), "Profile updated.")),
);

// Avatar: upload through POST /uploads/presign (purpose "avatar"), then save the URL here.
router.post(
  "/me/avatar",
  body("avatarUrl").isURL({ require_tld: false }).withMessage("avatarUrl is required"),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.updateProfile(req.auth.userId, { avatarUrl: req.body.avatarUrl }), "Avatar updated.")),
);

router.get("/me/preferences", asyncHandler(async (req, res) => ok(res, await profile.getPreferences(req.auth.userId), "Preferences fetched.")));
router.patch(
  "/me/preferences",
  body("language").optional().isIn(["en", "hi"]).withMessage("Unsupported language"),
  body("vegOnly").optional().isBoolean(),
  body("channels").optional().isObject(),
  body("topics").optional().isObject(),
  validate,
  asyncHandler(async (req, res) => ok(res, await profile.updatePreferences(req.auth.userId, req.body, { ip: req.ip, deviceId: req.headers["x-device-id"] || null }), "Preferences saved.")),
);

router.post(
  "/me/phone/otp",
  body("countryCode").optional().matches(/^\+\d{1,3}$/),
  body("phoneNumber").matches(/^[6-9]\d{9}$/).withMessage("Invalid phone number"),
  validate,
  otpRateLimiter,
  asyncHandler(async (req, res) => ok(res, await profile.requestPhoneChange(req.auth.userId, req.body), "OTP sent to the new number.")),
);
router.post(
  "/me/phone/verify",
  body("countryCode").optional().matches(/^\+\d{1,3}$/),
  body("phoneNumber").matches(/^[6-9]\d{9}$/).withMessage("Invalid phone number"),
  body("otp").matches(/^\d{4,6}$/).withMessage("Invalid OTP"),
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
