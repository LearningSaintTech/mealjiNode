import axios from "axios";
import { AppError } from "../common/errors/AppError.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const client = axios.create({ timeout: 12000 });

function providerConfig() {
  if (!env.twoFactorApiKey) {
    throw new AppError(500, "OTP provider is not configured");
  }
  return {
    apiKey: env.twoFactorApiKey,
    api: `${env.twoFactorBaseUrl}/API/V1`,
    template: env.twoFactorTemplate || "OTPtemplate",
  };
}

function providerDetails(error) {
  const data = error?.response?.data;
  return String(data?.Details || data?.Message || error?.message || "Unknown error").slice(0, 200);
}

function httpFail(error, action) {
  if (error instanceof AppError) throw error;
  logger.error(
    { action, status: error?.response?.status, details: providerDetails(error) },
    "2Factor request failed",
  );
  throw new AppError(502, `Failed to ${action}`);
}

export async function providerSendOtp(mobile) {
  const { apiKey, api, template } = providerConfig();
  const digits = String(mobile || "").replace(/\D/g, "");
  if (!digits) throw new AppError(400, "Invalid mobile number");

  let response;
  try {
    response = await client.get(`${api}/${apiKey}/SMS/${digits}/AUTOGEN/${template}`);
  } catch (error) {
    httpFail(error, "send OTP");
  }

  if (response?.data?.Status === "Success" && response.data.Details) {
    return { sessionId: response.data.Details };
  }

  logger.error(
    { action: "send OTP", details: String(response?.data?.Details || "Unknown error").slice(0, 200) },
    "2Factor rejected OTP send",
  );
  throw new AppError(400, "Failed to send OTP");
}

export async function providerVerifyOtp({ sessionId, otp }) {
  const { apiKey, api } = providerConfig();

  let response;
  try {
    response = await client.get(`${api}/${apiKey}/SMS/VERIFY/${sessionId}/${encodeURIComponent(String(otp))}`);
  } catch (error) {
    // 2Factor answers a wrong or expired code with HTTP 400. That is the user's
    // mistake, not a provider outage, so it must count as an invalid attempt.
    const status = error?.response?.status;
    if (status && status >= 400 && status < 500 && status !== 401 && status !== 403) {
      return rejectCode(providerDetails(error));
    }
    httpFail(error, "verify OTP");
  }

  if (response?.data?.Status === "Success") return true;
  return rejectCode(String(response?.data?.Details || response?.data?.Message || ""));
}

function rejectCode(details) {
  const expired = /expired|timeout/i.test(details);
  throw new AppError(400, expired ? "OTP expired. Please request a new OTP." : "Invalid OTP.");
}
