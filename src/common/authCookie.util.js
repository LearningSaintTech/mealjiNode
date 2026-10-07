import { env } from "../config/env.js";
import { durationToSeconds } from "./duration.js";

export const REFRESH_COOKIE_NAME = "refreshToken";

export function refreshTokenCookieOptions() {
  const sameSite = env.isProd ? "none" : env.cookieSameSite;
  return {
    httpOnly: true,
    secure: env.isProd || sameSite === "none",
    sameSite,
    path: "/",
    ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
    maxAge: durationToSeconds(env.refreshTokenExpiresIn) * 1000,
  };
}

export function clearRefreshTokenCookie(res) {
  const options = refreshTokenCookieOptions();
  delete options.maxAge;
  res.clearCookie(REFRESH_COOKIE_NAME, options);
}
