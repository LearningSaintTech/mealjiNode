import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { appConfigController } from "./settings.controller.js";

// Public, unauthenticated endpoints the app calls before sign-in. When a token
// is sent, the config also carries the person's experiment variants.
const router = Router();

function optionalAuth(req, res, next) {
  if (!req.headers.authorization) return next();
  return authMiddleware(req, res, () => next());
}

router.get("/config", optionalAuth, asyncHandler(appConfigController));

export default router;
