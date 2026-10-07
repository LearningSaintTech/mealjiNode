import { AppError } from "./errors/AppError.js";

const DEVICE_ID = /^[\w.-]{8,80}$/;

export function requireDeviceId(deviceId) {
  const raw = deviceId == null ? "" : String(deviceId).trim();
  if (!raw || raw === "undefined" || raw === "null") {
    throw new AppError(400, "x-device-id is required");
  }
  if (!DEVICE_ID.test(raw)) {
    throw new AppError(400, "x-device-id is invalid");
  }
  return raw;
}
