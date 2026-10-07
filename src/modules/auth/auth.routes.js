import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { loginRateLimiter, otpRateLimiter, refreshTokenRateLimiter, verifyOtpRateLimiter } from "../../infrastructure/rateLimit.js";
import {
  loginController,
  logoutController,
  staffLoginController,
  meController,
  refreshController,
  resendOtpController,
  verifyOtpController,
} from "./auth.controller.js";
import { loginValidation, resendOtpValidation, staffLoginValidation, verifyOtpValidation } from "./auth.validation.js";

const router = Router();

router.post("/login", loginValidation, validate, loginRateLimiter, asyncHandler(loginController));
router.post("/staff-login", staffLoginValidation, validate, loginRateLimiter, asyncHandler(staffLoginController));
router.post("/resend-otp", resendOtpValidation, validate, otpRateLimiter, asyncHandler(resendOtpController));
router.post("/verify-otp", verifyOtpValidation, validate, verifyOtpRateLimiter, asyncHandler(verifyOtpController));
router.post("/refresh", refreshTokenRateLimiter, asyncHandler(refreshController));
router.post("/logout", authMiddleware, asyncHandler(logoutController));
router.get("/me", authMiddleware, asyncHandler(meController));

export default router;
