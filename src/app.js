import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import mongoose from "mongoose";
import pinoHttp from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { errorHandler } from "./common/middleware/errorHandler.js";
import { notFound } from "./common/middleware/notFound.js";
import { metricsHandler, metricsMiddleware, recordMountPath } from "./common/metrics.js";
import { sendSuccess } from "./common/responses/apiResponse.js";
import { redis } from "./config/redis.js";
import { workersActive } from "./jobs/queue.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import kitchenRoutes from "./modules/kitchen/kitchen.routes.js";
import locationRoutes from "./modules/location/location.routes.js";
import appRoutes from "./modules/settings/app.routes.js";
import { addressRouter, geoRouter } from "./modules/address/address.routes.js";
import { adminAnalyticsRouter, ingestRouter } from "./modules/analytics/analytics.routes.js";
import { adminBillingRouter, invoiceRouter } from "./modules/billing/billing.routes.js";
import cartRoutes from "./modules/cart/cart.routes.js";
import { adminCatalogRouter, adminKitchenMenuRouter, customerCatalogRouter, kitchenMenuRouter } from "./modules/catalog/catalog.routes.js";
import { adminContentRouter, customerContentRouter, publicContentRouter } from "./modules/content/content.routes.js";
import { adminNotificationRouter, customerNotificationRouter, notificationWebhookRouter, publicNotificationRouter } from "./modules/notification/notification.routes.js";
import { adminOrderRouter, customerOrderRouter, kitchenOrderRouter } from "./modules/order/order.routes.js";
import { adminPaymentRouter, paymentRouter, webhookRouter } from "./modules/payment/payment.routes.js";
import profileRoutes from "./modules/profile/profile.routes.js";
import { adminReportRouter, kitchenReportRouter } from "./modules/report/report.routes.js";
import uploadRoutes from "./modules/upload/upload.routes.js";
import { LOCAL_DIR, signedFileUrl } from "./modules/upload/upload.service.js";
import { adminKitchenExtrasRouter, kitchenExtrasRouter } from "./modules/kitchen/kitchen.extras.routes.js";
import { mountPhaseRoutes } from "./routes.phases.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(cors({
    origin: env.corsOrigin,
    credentials: true,
  }));
  // Provider webhooks need the raw body for signature checks: before the JSON parser.
  app.use("/api/v1/webhooks", recordMountPath, webhookRouter);
  app.use("/api/v1/webhooks", recordMountPath, notificationWebhookRouter);
  app.use("/api/v1/uploads", recordMountPath, uploadRoutes);
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());
  app.use(pinoHttp({
    logger,
    genReqId(req, res) {
      const header = req.headers["x-request-id"];
      const id = typeof header === "string" && header.trim()
        ? header.trim().slice(0, 80)
        : crypto.randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  }));

  app.use(metricsMiddleware);

  app.get("/health", (req, res) => {
    sendSuccess(res, { message: "ok", data: { status: "up" } });
  });

  // Readiness for load balancers: 503 until MongoDB is reachable.
  app.get("/health/ready", async (req, res) => {
    let mongo = "down";
    try {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.db.admin().command({ ping: 1 });
        mongo = "up";
      }
    } catch {
      mongo = "down";
    }
    const data = {
      status: mongo === "up" ? "ready" : "not_ready",
      mongo,
      redis: redis.status === "ready" ? "up" : "down",
      // "off" when this process runs no workers (production api); the worker reports its own.
      queues: workersActive() ? "up" : env.runWorkersInApi ? "down" : "off",
    };
    res.status(mongo === "up" ? 200 : 503).json({ success: mongo === "up", message: data.status, data });
  });

  app.get("/metrics", metricsHandler);

  // Locally stored uploads (development storage driver).
  // Images are shown by the consoles and the app from other origins.
  if (env.storageDriver === "local") {
    app.use("/files", (req, res, next) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      next();
    }, express.static(LOCAL_DIR, { maxAge: "7d", fallthrough: false }));
  } else if (env.storageDriver === "s3" && !env.cdnBaseUrl) {
    // S3 without a public CDN: redirect to a short-lived signed link. Clients
    // cache the redirect for a while; the signed link outlives that.
    app.get("/files/*", (req, res, next) => {
      try {
        const key = decodeURIComponent(req.path.replace(/^\/files\//, ""));
        res.setHeader("Cache-Control", "public, max-age=1800");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        return res.redirect(302, signedFileUrl(key, 3600));
      } catch (err) {
        return next(err);
      }
    });
  }
  app.use("/", publicNotificationRouter);

  app.use("/api/v1/app", recordMountPath, appRoutes);
  app.use("/api/v1/auth", recordMountPath, authRoutes);
  app.use("/api/v1", recordMountPath, publicContentRouter);
  app.use("/api/v1/analytics", recordMountPath, ingestRouter);
  app.use("/api/v1/users", recordMountPath, locationRoutes);
  app.use("/api/v1/users", recordMountPath, profileRoutes);
  app.use("/api/v1/users", recordMountPath, addressRouter);
  app.use("/api/v1/orders", recordMountPath, customerOrderRouter);
  app.use("/api/v1/payments", recordMountPath, paymentRouter);
  app.use("/api/v1/invoices", recordMountPath, invoiceRouter);
  app.use("/api/v1/kitchen/menu", recordMountPath, kitchenMenuRouter);
  app.use("/api/v1/kitchen/orders", recordMountPath, kitchenOrderRouter);
  app.use("/api/v1/kitchen/reports", recordMountPath, kitchenReportRouter);
  app.use("/api/v1/kitchen", recordMountPath, kitchenExtrasRouter);
  app.use("/api/v1/kitchen", recordMountPath, kitchenRoutes);
  app.use("/api/v1/admin/kitchens/:kitchenId/menu", recordMountPath, adminKitchenMenuRouter);
  app.use("/api/v1/admin/analytics", recordMountPath, adminAnalyticsRouter);
  app.use("/api/v1/admin", recordMountPath, adminCatalogRouter);
  app.use("/api/v1/admin", recordMountPath, adminContentRouter);
  app.use("/api/v1/admin", recordMountPath, adminOrderRouter);
  app.use("/api/v1/admin", recordMountPath, adminPaymentRouter);
  app.use("/api/v1/admin", recordMountPath, adminBillingRouter);
  app.use("/api/v1/admin", recordMountPath, adminNotificationRouter);
  app.use("/api/v1/admin", recordMountPath, adminReportRouter);
  app.use("/api/v1/admin", recordMountPath, adminKitchenExtrasRouter);
  app.use("/api/v1/admin", recordMountPath, adminRoutes);
  mountPhaseRoutes(app);
  // Customer routes mounted at the API root last (menu, cart, home…).
  app.use("/api/v1", recordMountPath, customerCatalogRouter);
  app.use("/api/v1", recordMountPath, customerContentRouter);
  app.use("/api/v1", recordMountPath, cartRoutes);
  app.use("/api/v1", recordMountPath, geoRouter);
  app.use("/api/v1", recordMountPath, customerNotificationRouter);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
