import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { idempotent } from "../../common/middleware/idempotency.js";
import { placeSearchLimiter } from "../../infrastructure/rateLimit.js";
import { listAuditLogsController } from "../audit/audit.controller.js";
import { listAuditLogsValidation } from "../audit/audit.validation.js";
import {
  cancelScheduledSettingController,
  getLimitsController,
  setLimitsController,
  getSettingController,
  listDefinitionsController,
  updateSettingController,
} from "../settings/settings.controller.js";
import { cancelScheduledValidation, getSettingValidation, setLimitsValidation, settingKeyParam, updateSettingValidation } from "../settings/settings.validation.js";
import {
  createRoleController,
  createStaffController,
  deleteRoleController,
  updateRoleMetaController,
  getUserController,
  listPermissionsController,
  listRolesController,
  listUsersController,
  resetRolePermissionsController,
  statsController,
  updateRolePermissionsController,
  updateRoleController,
  updateStatusController,
} from "./admin.controller.js";
import {
  getKitchenController,
  listKitchensController,
  onboardKitchenController,
  searchPlacesController,
  updateKitchenController,
  updateKitchenStatusController,
} from "../kitchen/kitchen.controller.js";
import {
  kitchenIdParam,
  listKitchensValidation,
  onboardKitchenValidation,
  kitchenStatusValidation,
  placeSearchValidation,
  updateKitchenValidation,
} from "../kitchen/kitchen.validation.js";
import {
  createRoleValidation,
  createStaffValidation,
  updateRoleMetaValidation,
  listUsersValidation,
  roleSlugParam,
  updateRolePermissionsValidation,
  updateRoleValidation,
  updateStatusValidation,
  userIdParam,
} from "./admin.validation.js";

const router = Router();

router.use(authMiddleware);

router.get("/stats", authorize("users.read"), asyncHandler(statsController));
router.post("/staff", authorize("staff.create"), createStaffValidation, validate, idempotent(), asyncHandler(createStaffController));
router.get("/users", authorize("users.read"), listUsersValidation, validate, asyncHandler(listUsersController));
router.get("/users/:userId", authorize("users.read"), userIdParam, validate, asyncHandler(getUserController));
router.patch("/users/:userId/status", authorize("users.update_status"), updateStatusValidation, validate, asyncHandler(updateStatusController));
router.patch("/users/:userId/role", authorize("staff.update_role"), updateRoleValidation, validate, asyncHandler(updateRoleController));
router.get("/places", authorize("kitchens.manage"), placeSearchValidation, validate, placeSearchLimiter, asyncHandler(searchPlacesController));
router.post("/kitchens", authorize("kitchens.manage"), onboardKitchenValidation, validate, idempotent(), asyncHandler(onboardKitchenController));
router.get("/kitchens", authorize("kitchens.read"), listKitchensValidation, validate, asyncHandler(listKitchensController));
router.get("/kitchens/:kitchenId", authorize("kitchens.read"), kitchenIdParam, validate, asyncHandler(getKitchenController));
router.patch("/kitchens/:kitchenId", authorize("kitchens.manage"), updateKitchenValidation, validate, asyncHandler(updateKitchenController));
router.patch("/kitchens/:kitchenId/status", authorize("kitchens.manage"), kitchenStatusValidation, validate, asyncHandler(updateKitchenStatusController));
router.get("/roles", authorize("roles.read"), asyncHandler(listRolesController));
router.post("/roles", authorize("roles.manage"), createRoleValidation, validate, asyncHandler(createRoleController));
router.patch("/roles/:slug", authorize("roles.manage"), updateRoleMetaValidation, validate, asyncHandler(updateRoleMetaController));
router.delete("/roles/:slug", authorize("roles.manage"), roleSlugParam, validate, asyncHandler(deleteRoleController));
router.put("/roles/:slug/permissions", authorize("roles.manage"), updateRolePermissionsValidation, validate, asyncHandler(updateRolePermissionsController));
router.post("/roles/:slug/reset", authorize("roles.manage"), roleSlugParam, validate, asyncHandler(resetRolePermissionsController));
router.get("/settings", authorize("settings.read"), asyncHandler(listDefinitionsController));
router.get("/settings/:key/limits", authorize("settings.read"), settingKeyParam, validate, asyncHandler(getLimitsController));
router.put("/settings/:key/limits", authorize("settings.read"), setLimitsValidation, validate, asyncHandler(setLimitsController));
router.get("/settings/:key", authorize("settings.read"), getSettingValidation, validate, asyncHandler(getSettingController));
router.put("/settings/:key", authorize("settings.read"), updateSettingValidation, validate, asyncHandler(updateSettingController));
router.delete("/settings/:key/versions/:version", authorize("settings.read"), cancelScheduledValidation, validate, asyncHandler(cancelScheduledSettingController));
router.get("/audit-logs", authorize("audit.read"), listAuditLogsValidation, validate, asyncHandler(listAuditLogsController));
router.get("/permissions", authorize("permissions.read"), asyncHandler(listPermissionsController));

export default router;
