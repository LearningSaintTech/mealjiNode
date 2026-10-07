import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { locationRateLimiter } from "../../infrastructure/rateLimit.js";
import { getLocationController, serviceabilityController, updateLocationController } from "./location.controller.js";
import { serviceabilityValidation, updateLocationValidation } from "./location.validation.js";

const router = Router();

router.use(authMiddleware);
router.put("/me/location", updateLocationValidation, validate, locationRateLimiter, asyncHandler(updateLocationController));
router.get("/me/location", asyncHandler(getLocationController));
router.get("/me/serviceability", serviceabilityValidation, validate, asyncHandler(serviceabilityController));

export default router;
