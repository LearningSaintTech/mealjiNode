import express, { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { ok } from "../../common/http.js";
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
