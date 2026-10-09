import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durationToSeconds } from "../common/duration.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envPath = path.join(rootDir, ".env");
const envFile = dotenv.config({ path: envPath, quiet: true });

function int(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["true", "1", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function redisPrefix(value) {
  const raw = (value || "mealji:").trim();
  return raw.endsWith(":") ? raw : `${raw}:`;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";
const sameSite = String(process.env.COOKIE_SAMESITE || "lax").trim().toLowerCase();

const corsRaw = process.env.CORS_ORIGIN || "http://localhost:5173";
const corsList = corsRaw.split(",").map((item) => item.trim()).filter(Boolean);

export const env = {
  nodeEnv,
  isProd,
  port: int("PORT", 4000),
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mealji",
  trustProxy: process.env.TRUST_PROXY === "false" ? false : int("TRUST_PROXY", 1),
  corsOrigin: corsList.length <= 1 ? (corsList[0] || "http://localhost:3000") : corsList,
  logLevel: process.env.LOG_LEVEL || "info",
  // pino-pretty is a devDependency: only used in development unless forced.
  logPretty: process.env.LOG_PRETTY ? bool("LOG_PRETTY", false) : nodeEnv === "development",
  redisHost: process.env.REDIS_HOST || "127.0.0.1",
  redisPort: int("REDIS_PORT", 6379),
  redisPassword: process.env.REDIS_PASSWORD || "",
  redisTls: bool("REDIS_TLS", false),
  redisKeyPrefix: redisPrefix(process.env.REDIS_KEY_PREFIX),
  accessTokenSecret: process.env.ACCESS_TOKEN_SECRET || "",
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || "",
  accessTokenExpiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "1h",
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || "60d",
  refreshTokenGraceSec: int("REFRESH_TOKEN_GRACE_SEC", 180),
  cookieDomain: (process.env.COOKIE_DOMAIN || "").trim(),
  cookieSameSite: ["lax", "strict", "none"].includes(sameSite) ? sameSite : "lax",
  twoFactorApiKey: String(process.env.TWOFACTOR_API_KEY || "").trim(),
  fixedOtp: String(process.env.FIXED_OTP || "").trim(),
  twoFactorTemplate: String(process.env.TWOFACTOR_OTP_TEMPLATE_NAME || "OTPtemplate").trim(),
  twoFactorBaseUrl: String(process.env.TWOFACTOR_BASE_URL || "https://2factor.in").trim().replace(/\/$/, ""),
  googleMapsApiKey: String(process.env.GOOGLE_MAPS_API_KEY || "").trim(),
  googleMapsGeocodeUrl: String(process.env.GOOGLE_MAPS_GEOCODE_URL || "https://maps.googleapis.com/maps/api/geocode/json").trim(),
  googleMapsLanguage: String(process.env.GOOGLE_MAPS_LANGUAGE || "en").trim(),
  googleMapsRegion: String(process.env.GOOGLE_MAPS_REGION || "in").trim(),
  appleReviewOtpEnabled: bool("APPLE_REVIEW_OTP_ENABLED", false),
  appleReviewPhone: String(process.env.APPLE_REVIEW_PHONE || "").trim(),
  appleReviewOtp: String(process.env.APPLE_REVIEW_OTP || "").trim(),
  seedAdminName: process.env.SEED_ADMIN_NAME || "MealJi Admin",
  seedAdminCountryCode: process.env.SEED_ADMIN_COUNTRY_CODE || "+91",
  seedAdminPhone: String(process.env.SEED_ADMIN_PHONE || "").trim(),
  otpRateLimit: int("OTP_RATE_LIMIT", isProd ? 30 : 100),
  otpRateWindowSec: int("OTP_RATE_WINDOW_SEC", 3600),
  loginRateLimit: int("LOGIN_RATE_LIMIT", isProd ? 40 : 120),
  loginRateWindowSec: int("LOGIN_RATE_WINDOW_SEC", 3600),
  verifyOtpRateLimit: int("VERIFY_OTP_RATE_LIMIT", isProd ? 40 : 120),
  verifyOtpRateWindowSec: int("VERIFY_OTP_RATE_WINDOW_SEC", 3600),
  refreshRateLimit: int("REFRESH_RATE_LIMIT", isProd ? 80 : 200),
  refreshRateWindowSec: int("REFRESH_RATE_WINDOW_SEC", 3600),
  otpIpSoftLimit: int("OTP_IP_SOFT_LIMIT", isProd ? 300 : 1000),
  otpIpSoftWindowSec: int("OTP_IP_SOFT_WINDOW_SEC", 3600),
  rateLimitRedisTimeoutMs: int("RATE_LIMIT_REDIS_TIMEOUT_MS", 2000),
  otpResendCooldownSec: int("OTP_RESEND_COOLDOWN_SEC", 45),
  otpMaxAttempts: int("OTP_MAX_ATTEMPTS", 5),
  // Failed OTP checks allowed per account per 24 h, across all re-sends.
  otpDailyFailureLimit: int("OTP_DAILY_FAILURE_LIMIT", 20),
  locationRateLimit: int("LOCATION_RATE_LIMIT", isProd ? 30 : 100),
  locationRateWindowSec: int("LOCATION_RATE_WINDOW_SEC", 3600),
  mongoRequireReplicaSet: bool("MONGO_REQUIRE_REPLICA_SET", isProd),
  // The api process also runs the background workers unless this is false.
  // Production runs `npm run worker` separately and sets this to false.
  runWorkersInApi: bool("RUN_WORKERS_IN_API", !isProd),
  outboxRelayIntervalMs: int("OUTBOX_RELAY_INTERVAL_MS", 2000),
  metricsToken: String(process.env.METRICS_TOKEN || "").trim(),
  idempotencyTtlSec: int("IDEMPOTENCY_TTL_SEC", 86400),

  // Public origin of this API (links in emails, local upload URLs, webhooks).
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || `http://localhost:${int("PORT", 4000)}`).trim().replace(/\/$/, ""),

  // File storage: "local" writes under ./uploads (development); "s3" uses pre-signed PUTs.
  storageDriver: String(process.env.STORAGE_DRIVER || "local").trim(),
  storageSecret: String(process.env.STORAGE_SECRET || process.env.ACCESS_TOKEN_SECRET || "dev-storage-secret").trim(),
  s3Bucket: String(process.env.S3_BUCKET || "").trim(),
  s3Region: String(process.env.S3_REGION || "ap-south-1").trim(),
  awsAccessKeyId: String(process.env.AWS_ACCESS_KEY_ID || "").trim(),
  awsSecretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
  // Every object key starts with this folder, so a shared bucket stays tidy.
  s3KeyPrefix: String(process.env.S3_KEY_PREFIX || "").trim().replace(/^\/+|\/+$/g, ""),
  // Public CDN in front of the bucket. Without it, files are served through
  // the API (/files/<key> redirects to a short-lived signed S3 link).
  cdnBaseUrl: String(process.env.CDN_BASE_URL || "").trim().replace(/\/$/, ""),
  // Hosts that email/redirect links may open (plus PUBLIC_BASE_URL and CDN hosts).
  linkHostsExtra: String(process.env.LINK_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),

  // Payments. Without Razorpay keys the "test" gateway is used (development only).
  razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || "").trim(),
  razorpayKeySecret: String(process.env.RAZORPAY_KEY_SECRET || "").trim(),
  razorpayWebhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim(),

  // Notifications. Each channel logs instead of sending until configured.
  fcmProjectId: String(process.env.FCM_PROJECT_ID || "").trim(),
  fcmClientEmail: String(process.env.FCM_CLIENT_EMAIL || "").trim(),
  fcmPrivateKey: String(process.env.FCM_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  whatsappToken: String(process.env.WHATSAPP_TOKEN || "").trim(),
  whatsappPhoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
  whatsappAppSecret: String(process.env.WHATSAPP_APP_SECRET || "").trim(),
  whatsappVerifyToken: String(process.env.WHATSAPP_VERIFY_TOKEN || "").trim(),
  smsSenderId: String(process.env.SMS_SENDER_ID || "MEALJI").trim(),
  emailFrom: String(process.env.EMAIL_FROM || "MealJi <no-reply@mealji.local>").trim(),
  sesRegion: String(process.env.SES_REGION || process.env.S3_REGION || "ap-south-1").trim(),
  emailWebhookToken: String(process.env.EMAIL_WEBHOOK_TOKEN || "").trim(),
};

export function assertRuntimeEnv() {
  const problems = [];

  if (envFile.error?.code === "ENOENT") {
    problems.push(".env was not found. Copy .env.example to .env");
  }
  if (!env.mongoUri) problems.push("MONGO_URI is required");
  if (!env.accessTokenSecret || env.accessTokenSecret.length < 32) {
    problems.push("ACCESS_TOKEN_SECRET must be at least 32 characters");
  }
  if (!env.refreshTokenSecret || env.refreshTokenSecret.length < 32) {
    problems.push("REFRESH_TOKEN_SECRET must be at least 32 characters");
  }
  if (env.accessTokenSecret && env.accessTokenSecret === env.refreshTokenSecret) {
    problems.push("ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different");
  }

  try {
    durationToSeconds(env.accessTokenExpiresIn);
    durationToSeconds(env.refreshTokenExpiresIn);
  } catch {
    problems.push("Token expiry values must look like 30d, 12h, 15m, or 60s");
  }

  if (env.isProd && !env.twoFactorApiKey) {
    problems.push("TWOFACTOR_API_KEY is required in production");
  }
  if (env.fixedOtp && !/^\d{4,6}$/.test(env.fixedOtp)) {
    problems.push("FIXED_OTP must be 4 to 6 digits");
  }
  if (env.isProd && env.fixedOtp) {
    problems.push("FIXED_OTP must be empty in production");
  }

  if (env.appleReviewOtpEnabled && (!env.appleReviewPhone || !env.appleReviewOtp)) {
    problems.push("APPLE_REVIEW_PHONE and APPLE_REVIEW_OTP are required when review OTP is enabled");
  }
  if (env.appleReviewOtpEnabled && env.appleReviewOtp && !/^\d{6}$/.test(env.appleReviewOtp)) {
    problems.push("APPLE_REVIEW_OTP must be 6 digits");
  }

  if (env.isProd && (!env.razorpayKeyId || !env.razorpayKeySecret || !env.razorpayWebhookSecret)) {
    problems.push("RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required in production");
  }
  if (env.storageDriver === "s3" && (!env.s3Bucket || !env.awsAccessKeyId || !env.awsSecretAccessKey)) {
    problems.push("S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3");
  }
  if (env.isProd && env.storageDriver === "local") {
    problems.push("STORAGE_DRIVER=local is for development; use s3 in production");
  }

  if (problems.length) {
    throw new Error(problems.join("; "));
  }
}

export { rootDir };
