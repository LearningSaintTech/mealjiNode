import crypto from "node:crypto";
import { AppError } from "../common/errors/AppError.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { OTP_LENGTH, OTP_TTL } from "../constants/otp.constants.js";
import { storeDel, storeGet, storeSet } from "./redisStore.js";

const OTP_UNAVAILABLE = "OTP service temporarily unavailable. Please try again.";
const localKey = (purpose, subjectId) => `otp:${purpose}:${subjectId}`;

export async function createLocalOtp({ subjectId, purpose }) {
  if (env.isProd) throw new AppError(500, "OTP provider is not configured");

  const otp = String(crypto.randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH));
  await storeSet(localKey(purpose, subjectId), otp, OTP_TTL, { unavailableMessage: OTP_UNAVAILABLE });
  logger.info({ userId: String(subjectId), purpose, devOtp: otp }, "Development OTP issued");
  return otp;
}

export async function readLocalOtp({ subjectId, purpose }) {
  return storeGet(localKey(purpose, subjectId), {
    failClosed: true,
    unavailableMessage: OTP_UNAVAILABLE,
  });
}

export async function deleteLocalOtp({ subjectId, purpose }) {
  await storeDel(localKey(purpose, subjectId));
}
