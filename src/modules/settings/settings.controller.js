import { AppError } from "../../common/errors/AppError.js";
import { sendSuccess } from "../../common/responses/apiResponse.js";
import { getDefinition } from "./settings.definitions.js";
import * as settingsService from "./settings.service.js";
import { userRepository } from "../user/user.repository.js";

export async function listDefinitionsController(req, res) {
  const data = await settingsService.listSettingDefinitions();
  return sendSuccess(res, { message: "Settings fetched.", data });
}

export async function getLimitsController(req, res) {
  const definition = getDefinition(req.params.key);
  if (!definition) throw new AppError(404, "Setting not found");
  const fields = await settingsService.getLimits(req.params.key);
  return sendSuccess(res, { message: "Kitchen limits fetched.", data: { key: req.params.key, fields } });
}

export async function setLimitsController(req, res) {
  const definition = getDefinition(req.params.key);
  if (!definition) throw new AppError(404, "Setting not found");
  if (!req.auth.permissions.includes(definition.permission)) {
    throw new AppError(403, "You do not have permission to change this setting");
  }
  const data = await settingsService.setLimits(req.params.key, req.body.fields, { req });
  return sendSuccess(res, { message: "Kitchen limits saved.", data });
}

export async function getSettingController(req, res) {
  const data = await settingsService.getSettingDetail(req.params.key, {
    scopeType: req.query.scopeType || "global",
    scopeId: req.query.scopeId || "",
  });
  return sendSuccess(res, { message: "Setting fetched.", data });
}

export async function updateSettingController(req, res) {
  const definition = getDefinition(req.params.key);
  if (!definition) throw new AppError(404, "Setting not found");
  // Each setting group has its own edit permission (e.g. settings.app).
  if (!req.auth.permissions.includes(definition.permission)) {
    throw new AppError(403, "You do not have permission to change this setting");
  }
  const data = await settingsService.updateSetting(req.params.key, req.body, { req });
  const scheduled = req.body.effectiveFrom && new Date(req.body.effectiveFrom) > new Date();
  return sendSuccess(res, { message: scheduled ? "Change scheduled." : "Setting saved.", data });
}

async function ownKitchenId(req) {
  const user = await userRepository.findById(req.auth.userId);
  if (!user?.kitchen) throw new AppError(404, "Kitchen not found");
  return String(user.kitchen._id || user.kitchen);
}

export async function listKitchenSettingsController(req, res) {
  const data = await settingsService.listSettingDefinitions({ kitchenOnly: true });
  return sendSuccess(res, { message: "Kitchen settings fetched.", data });
}

export async function getKitchenSettingController(req, res) {
  const data = await settingsService.getSettingDetail(req.params.key, {
    scopeType: "kitchen",
    scopeId: await ownKitchenId(req),
    kitchenOnly: true,
  });
  return sendSuccess(res, { message: "Kitchen setting fetched.", data });
}

export async function updateKitchenSettingController(req, res) {
  const data = await settingsService.updateSetting(req.params.key, {
    scopeType: "kitchen",
    scopeId: await ownKitchenId(req),
    values: req.body.values,
    reason: req.body.reason,
  }, { req, kitchenOnly: true });
  return sendSuccess(res, { message: "Kitchen setting saved.", data });
}

export async function cancelScheduledSettingController(req, res) {
  const definition = getDefinition(req.params.key);
  if (!definition) throw new AppError(404, "Setting not found");
  if (!req.auth.permissions.includes(definition.permission)) {
    throw new AppError(403, "You do not have permission to change this setting");
  }
  const data = await settingsService.cancelScheduledSetting(req.params.key, req.params.version, {
    scopeType: req.query.scopeType || "global",
    scopeId: req.query.scopeId || "",
    req,
  });
  return sendSuccess(res, { message: "Scheduled change cancelled.", data });
}

export async function appConfigController(req, res) {
  const data = await settingsService.getPublicAppConfig();
  if (req.auth?.userId) {
    const { experimentsFor } = await import("../experiment/experiment.service.js");
    data.experiments = await experimentsFor(req.auth.userId).catch(() => ({}));
  }
  // Private: the body carries serverTime, which a shared cache would serve stale.
  res.setHeader("Cache-Control", "private, max-age=60");
  return sendSuccess(res, { message: "App config fetched.", data });
}
