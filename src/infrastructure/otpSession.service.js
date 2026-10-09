import { AppError } from "../common/errors/AppError.js";
import { normalizeMobile } from "../common/phone.util.js";
import { timingSafeEqualString } from "../common/timingSafe.js";
import { env } from "../config/env.js";
import { FIXED_OTP_SENTINEL, OTP_PURPOSE, OTP_TTL, REVIEW_SESSION_SENTINEL } from "../constants/otp.constants.js";
import { createLocalOtp, deleteLocalOtp, readLocalOtp } from "./localOtp.service.js";
import { storeDel, storeGet, storeIncr, storeSet } from "./redisStore.js";
import { providerSendOtp, providerVerifyOtp } from "./twofactorApi.service.js";

const OTP_UNAVAILABLE = "OTP service temporarily unavailable. Please try again.";

const sessionKey = (purpose, subjectId) => `otp2factor:session:${purpose}:${subjectId}`;
const attemptsKey = (purpose, subjectId) => `otp2factor:attempts:${purpose}:${subjectId}`;
// Not reset by re-sending, so re-requesting codes cannot reset the guess budget.
const failuresKey = (purpose, subjectId) => `otp:failures:${purpose}:${subjectId}`;
// Wrong codes are also counted per device, so a stranger guessing codes for
// someone's number locks out only their own device; the account-wide ceiling
// (5x the daily limit) still stops guessing spread over many devices.
const deviceFailuresKey = (purpose, subjectId, source) => `otp:failures:${purpose}:${subjectId}:${source}`;
const ACCOUNT_FAILURE_FACTOR = 5;
const DAY_SEC = 24 * 3600;

export function isReviewPhone(phoneNumber) {
  if (!env.appleReviewOtpEnabled) return false;
  const reviewPhone = normalizeMobile(env.appleReviewPhone);
  return Boolean(reviewPhone) && normalizeMobile(phoneNumber) === reviewPhone;
}

// True while a sent code is still waiting to be used (not verified, not
// expired, not locked out after too many wrong attempts).
export async function hasPendingOtp({ subjectId, purpose = OTP_PURPOSE }) {
  const session = await storeGet(sessionKey(purpose, subjectId), { unavailableMessage: OTP_UNAVAILABLE });
  if (session) return true;
  return Boolean(await readLocalOtp({ subjectId, purpose }));
}

export async function sendOtp({ subjectId, purpose = OTP_PURPOSE, phoneNumber }) {
  if (!subjectId || !phoneNumber) {
    throw new AppError(400, "subjectId and phoneNumber are required");
  }

  const key = sessionKey(purpose, subjectId);
  const local = { subjectId, purpose };
  await storeDel(attemptsKey(purpose, subjectId));

  if (isReviewPhone(phoneNumber)) {
    await deleteLocalOtp(local);
    await storeSet(key, REVIEW_SESSION_SENTINEL, OTP_TTL, { unavailableMessage: OTP_UNAVAILABLE });
    return;
  }

  if (env.fixedOtp) {
    await deleteLocalOtp(local);
    await storeSet(key, FIXED_OTP_SENTINEL, OTP_TTL, { unavailableMessage: OTP_UNAVAILABLE });
    return;
  }

  if (!env.twoFactorApiKey) {
    await storeDel(key);
    await createLocalOtp(local);
    return;
  }

  await deleteLocalOtp(local);
  const { sessionId } = await providerSendOtp(normalizeMobile(phoneNumber));
  await storeSet(key, sessionId, OTP_TTL, { unavailableMessage: OTP_UNAVAILABLE });
}

export async function verifyOtp({ subjectId, purpose = OTP_PURPOSE, otp, source = null }) {
  if (!subjectId || !otp) {
    throw new AppError(400, "subjectId and otp are required");
  }

  const accountFailures = Number(await storeGet(failuresKey(purpose, subjectId), { unavailableMessage: OTP_UNAVAILABLE }) || 0);
  const deviceFailures = source ? Number(await storeGet(deviceFailuresKey(purpose, subjectId, source), { unavailableMessage: OTP_UNAVAILABLE }) || 0) : accountFailures;
  if (deviceFailures >= env.otpDailyFailureLimit || accountFailures >= env.otpDailyFailureLimit * (source ? ACCOUNT_FAILURE_FACTOR : 1)) {
    throw new AppError(429, "Too many incorrect codes. Try again tomorrow or contact support.");
  }

  const key = sessionKey(purpose, subjectId);
  const sessionId = await storeGet(key, { failClosed: true, unavailableMessage: OTP_UNAVAILABLE });
  const localCode = sessionId ? null : await readLocalOtp({ subjectId, purpose });

  if (!sessionId && !localCode) {
    throw new AppError(400, "OTP Expired");
  }

  try {
    if (sessionId === REVIEW_SESSION_SENTINEL) {
      if (!timingSafeEqualString(otp, env.appleReviewOtp)) {
        throw new AppError(400, "Invalid OTP.");
      }
    } else if (sessionId === FIXED_OTP_SENTINEL) {
      if (!timingSafeEqualString(otp, env.fixedOtp)) {
        throw new AppError(400, "Invalid OTP.");
      }
    } else if (sessionId) {
      await providerVerifyOtp({ sessionId, otp });
    } else if (!timingSafeEqualString(localCode, otp)) {
      throw new AppError(400, "Invalid OTP.");
    }
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode !== 400) throw err;
    await storeIncr(failuresKey(purpose, subjectId), DAY_SEC, { unavailableMessage: OTP_UNAVAILABLE });
    if (source) await storeIncr(deviceFailuresKey(purpose, subjectId, source), DAY_SEC, { unavailableMessage: OTP_UNAVAILABLE });
    const attempts = await storeIncr(attemptsKey(purpose, subjectId), OTP_TTL, {
      unavailableMessage: OTP_UNAVAILABLE,
    });
    if (attempts >= env.otpMaxAttempts) {
      await storeDel(key, attemptsKey(purpose, subjectId));
      await deleteLocalOtp({ subjectId, purpose });
      throw new AppError(400, "Too many invalid attempts. Request a new OTP.");
    }
    throw err;
  }

  await storeDel(key, attemptsKey(purpose, subjectId));
  await deleteLocalOtp({ subjectId, purpose });
  return true;
}
