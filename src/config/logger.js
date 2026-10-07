import pino from "pino";
import { env } from "./env.js";

const pretty = env.logPretty && !env.isProd;
// Note: LOG_PRETTY=true requires the pino-pretty devDependency to be installed.

export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers[\"x-refresh-token\"]",
      "res.headers[\"set-cookie\"]",
      "otp",
      "*.otp",
      "accessToken",
      "*.accessToken",
      "refreshToken",
      "*.refreshToken",
      "sessionId",
      "*.sessionId",
      "twoFactorApiKey",
      "*.twoFactorApiKey",
      "googleMapsApiKey",
      "*.googleMapsApiKey",
    ],
    censor: "[redacted]",
  },
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        },
      }
    : {}),
});
