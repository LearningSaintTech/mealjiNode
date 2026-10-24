import express, { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { ok } from "../../common/http.js";
import { accountLimiter } from "../../infrastructure/rateLimit.js";
import { handleProviderWebhook } from "./delivery.service.js";

// Delivery partner webhooks: mounted before the JSON parser so each adapter can
// check the signature on the raw bytes (the adapter rejects bad ones with 401).
// Unknown providers are acknowledged and ignored.
export const deliveryWebhookRouter = Router();
deliveryWebhookRouter.post(
  "/delivery/:provider",
  express.raw({ type: "*/*", limit: "256kb" }),
  asyncHandler(async (req, res) => ok(res, await handleProviderWebhook(req.params.provider, req.body, req.headers), "Received.")),
);

// "Call rider" (orders and meals) places a real phone call: a few per minute per customer.
export const callRiderLimiter = accountLimiter("call-rider", { limit: 3, windowSec: 60 });
