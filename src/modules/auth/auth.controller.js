import { clearRefreshTokenCookie, REFRESH_COOKIE_NAME, refreshTokenCookieOptions } from "../../common/authCookie.util.js";
import { sendSuccess } from "../../common/responses/apiResponse.js";
import { toPublicUser } from "../user/user.mapper.js";
import * as authService from "./auth.service.js";

function deviceIdFrom(req) {
  return req.headers["x-device-id"] || req.body?.deviceId;
}

export async function loginController(req, res) {
  const data = await authService.login(req.body);
  return sendSuccess(res, { status: 201, message: "OTP sent successfully.", data });
}

export async function staffLoginController(req, res) {
  const data = await authService.staffLogin(req.body);
  return sendSuccess(res, { status: 201, message: "OTP sent successfully.", data });
}

export async function resendOtpController(req, res) {
  const data = await authService.resendOtp(req.body);
  return sendSuccess(res, { status: 201, message: "OTP sent successfully.", data });
}

export async function verifyOtpController(req, res) {
  const data = await authService.verifyNumberOtp(req.body, deviceIdFrom(req));
  res.cookie(REFRESH_COOKIE_NAME, data.refreshToken, refreshTokenCookieOptions());
  return sendSuccess(res, {
    status: 201,
    message: "Phone number verified successfully.",
    data,
  });
}

export async function refreshController(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken || req.headers["x-refresh-token"];
  const data = await authService.refreshSession({
    refreshToken,
    deviceId: deviceIdFrom(req),
  });
  res.cookie(REFRESH_COOKIE_NAME, data.refreshToken, refreshTokenCookieOptions());
  return sendSuccess(res, { message: "Token refreshed successfully.", data });
}

export async function logoutController(req, res) {
  try {
    await authService.logout({
      userId: req.auth.userId,
      jti: req.auth.jti,
      exp: req.auth.exp,
      deviceId: deviceIdFrom(req),
    });
  } catch (err) {
    clearRefreshTokenCookie(res);
    throw err;
  }

  clearRefreshTokenCookie(res);
  return sendSuccess(res, { message: "Logged out successfully.", data: {} });
}

export async function meController(req, res) {
  return sendSuccess(res, {
    message: "Profile fetched successfully.",
    data: toPublicUser(req.auth.user),
  });
}
