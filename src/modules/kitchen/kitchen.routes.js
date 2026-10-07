import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { placeSearchLimiter } from "../../infrastructure/rateLimit.js";
import {
  getKitchenSettingController,
  listKitchenSettingsController,
  updateKitchenSettingController,
} from "../settings/settings.controller.js";
import { kitchenUpdateSettingValidation, settingKeyParam } from "../settings/settings.validation.js";
import {
  configureOwnKitchenController,
  inviteKitchenStaffController,
  listKitchenTeamController,
  ownKitchenController,
  searchPlacesController,
  updateKitchenStaffStatusController,
  updateServiceController,
} from "./kitchen.controller.js";
import {
  configureKitchenValidation,
  inviteKitchenStaffValidation,
  placeSearchValidation,
  kitchenStaffStatusValidation,
  serviceValidation,
} from "./kitchen.validation.js";

const router = Router();

router.use(authMiddleware, authorize("kitchen.desk"));
router.get("/places", authorize("kitchen.configure"), placeSearchValidation, validate, placeSearchLimiter, asyncHandler(searchPlacesController));
router.get("/me", asyncHandler(ownKitchenController));
router.patch("/me", authorize("kitchen.configure"), configureKitchenValidation, validate, asyncHandler(configureOwnKitchenController));
router.patch("/me/service", serviceValidation, validate, asyncHandler(updateServiceController));
router.get("/settings", authorize("kitchen.settings"), asyncHandler(listKitchenSettingsController));
router.get("/settings/:key", authorize("kitchen.settings"), settingKeyParam, validate, asyncHandler(getKitchenSettingController));
router.put("/settings/:key", authorize("kitchen.settings"), kitchenUpdateSettingValidation, validate, asyncHandler(updateKitchenSettingController));
router.get("/staff", authorize("kitchen.team"), asyncHandler(listKitchenTeamController));
router.post("/staff", authorize("kitchen.team"), inviteKitchenStaffValidation, validate, asyncHandler(inviteKitchenStaffController));
router.patch("/staff/:userId/status", authorize("kitchen.team"), kitchenStaffStatusValidation, validate, asyncHandler(updateKitchenStaffStatusController));

export default router;
