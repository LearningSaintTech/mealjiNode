import { Router } from "express";
import { body, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { ok } from "../../common/http.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { accountLimiter } from "../../infrastructure/rateLimit.js";
import * as analytics from "./analytics.service.js";

// Ingestion: signed-in or anonymous (x-device-id) clients, batches of up to 50.
export const ingestRouter = Router();

async function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return authMiddleware(req, res, (err) => next(err?.statusCode === 401 ? null : err));
}

ingestRouter.post(
  "/events",
  optionalAuth,
  accountLimiter("analytics", { limit: 600, windowSec: 60 }),
  body("events").isArray({ min: 1, max: 50 }).withMessage("Send 1 to 50 events"),
  body("events.*.name").isString().isLength({ max: 60 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await analytics.ingest(req.body.events, {
    userId: req.auth?.userId || null,
    deviceId: req.headers["x-device-id"] || null,
    platform: req.headers["x-platform"] || null,
    appVersion: req.headers["x-app-version"] || null,
  }), "Events received.", 202)),
);

// Dashboards.
export const adminAnalyticsRouter = Router();
adminAnalyticsRouter.use(authMiddleware, authorize("analytics.read"));
const rangeQuery = [query("from").optional().isISO8601({ strict: true }), query("to").optional().isISO8601({ strict: true }), query("kitchenId").optional({ values: "falsy" }).isMongoId()];

adminAnalyticsRouter.get("/overview", rangeQuery, validate, asyncHandler(async (req, res) => ok(res, await analytics.overview(req.query), "Overview.")));
adminAnalyticsRouter.get("/kitchens", rangeQuery, validate, asyncHandler(async (req, res) => ok(res, await analytics.kitchenLeaderboard(req.query), "Kitchens.")));
adminAnalyticsRouter.get("/live", asyncHandler(async (req, res) => ok(res, await analytics.liveOps(), "Live ops.")));
adminAnalyticsRouter.get("/funnel", rangeQuery, query("platform").optional().isIn(["android", "ios", "web"]), validate, asyncHandler(async (req, res) => ok(res, await analytics.funnel(req.query), "Funnel.")));
adminAnalyticsRouter.get("/retention", query("weeks").optional().isInt({ min: 2, max: 26 }).toInt(), validate, asyncHandler(async (req, res) => ok(res, await analytics.retentionCohorts({ weeks: req.query.weeks || 8 }), "Retention.")));
adminAnalyticsRouter.get("/subscriptions", rangeQuery, validate, asyncHandler(async (req, res) => ok(res, await (await import("../subscription/subscription.service.js")).subscriptionDashboard(req.query), "Subscriptions.")));
adminAnalyticsRouter.get("/marketing", rangeQuery, validate, asyncHandler(async (req, res) => ok(res, await (await import("../engagement/campaign.service.js")).marketingDashboard(req.query), "Marketing.")));
