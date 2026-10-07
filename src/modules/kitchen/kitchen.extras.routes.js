import { Router } from "express";
import { body, param } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok, ownKitchen } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { KITCHEN_PERMISSIONS } from "../../constants/permissions.js";
import { Address, toAddress } from "../address/address.model.js";
import { createRole, deleteRole, listRoles, updateCustomRole, updateRolePermissions } from "../admin/admin.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { entityForKitchen, toEntity } from "../billing/billing.service.js";
import { roleRepository } from "../role/role.repository.js";
import { resolveSetting } from "../settings/settings.service.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { toPublicUser } from "../user/user.mapper.js";
import { userRepository } from "../user/user.repository.js";
import { toKitchen } from "./kitchen.mapper.js";
import { Kitchen } from "./kitchen.model.js";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanWeeklyHours(list) {
  if (!Array.isArray(list) || list.length > 7) throw new AppError(422, "weeklyHours must list at most 7 days");
  const seen = new Set();
  return list.map((day, index) => {
    if (!Number.isInteger(day?.weekday) || day.weekday < 0 || day.weekday > 6 || seen.has(day.weekday)) throw new AppError(422, "Validation failed", [{ field: `weeklyHours[${index}].weekday`, message: "Each weekday (0-6) once" }]);
    seen.add(day.weekday);
    if (!day.closed && (!HHMM.test(day.opensAt || "") || !HHMM.test(day.closesAt || ""))) throw new AppError(422, "Validation failed", [{ field: `weeklyHours[${index}]`, message: "Open days need opensAt and closesAt (HH:mm)" }]);
    return { weekday: day.weekday, closed: Boolean(day.closed), opensAt: day.closed ? null : day.opensAt, closesAt: day.closed ? null : day.closesAt };
  }).sort((a, b) => a.weekday - b.weekday);
}

function cleanClosures(list) {
  if (!Array.isArray(list) || list.length > 120) throw new AppError(422, "closures must be a list of at most 120 dates");
  const dates = new Set();
  return list.map((item, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item?.date || "")) throw new AppError(422, "Validation failed", [{ field: `closures[${index}].date`, message: "Date must be YYYY-MM-DD" }]);
    if (dates.has(item.date)) throw new AppError(422, "Validation failed", [{ field: `closures[${index}].date`, message: "Duplicate date" }]);
    dates.add(item.date);
    return { date: item.date, reason: String(item.reason || "").slice(0, 120) };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

async function saveSchedule(req, kitchenId, patch) {
  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  const before = { weeklyHours: toKitchen(kitchen).weeklyHours, closures: toKitchen(kitchen).closures };
  if (patch.weeklyHours) kitchen.weeklyHours = cleanWeeklyHours(patch.weeklyHours);
  if (patch.closures) kitchen.closures = cleanClosures(patch.closures);
  await kitchen.save();
  const view = toKitchen(kitchen);
  await recordAudit(req, { action: "kitchen.schedule_changed", entityType: "kitchen", entityId: view.kitchenId, kitchenId: view.kitchenId, summary: `Changed hours/holidays of ${view.name}`, before, after: { weeklyHours: view.weeklyHours, closures: view.closures } });
  return view;
}

// ------------------------------------------------------------------ kitchen console
export const kitchenExtrasRouter = Router();
kitchenExtrasRouter.use(authFor(["/schedule", "/roles", "/billing-entity", "/about", "/staff"], authMiddleware));

kitchenExtrasRouter.put("/schedule", authorize("kitchen.configure"), ownKitchen, body("weeklyHours").optional().isArray(), body("closures").optional().isArray(), validate, asyncHandler(async (req, res) => (
  ok(res, await saveSchedule(req, req.kitchenId, req.body), "Hours saved.")
)));
kitchenExtrasRouter.get("/billing-entity", authorize("kitchen.desk"), ownKitchen, asyncHandler(async (req, res) => {
  const entity = await entityForKitchen(req.kitchenId);
  return ok(res, entity ? toEntity(entity) : null, "Billing entity fetched.");
}));
kitchenExtrasRouter.put("/about", authorize("kitchen.configure"), ownKitchen, asyncHandler(async (req, res) => {
  const kitchen = await Kitchen.findById(req.kitchenId);
  const about = { ...(kitchen.about?.toObject?.() || {}) };
  for (const key of ["chefName", "title", "story"]) if (req.body[key] !== undefined) about[key] = req.body[key] ? String(req.body[key]).slice(0, key === "story" ? 2000 : 120) : null;
  if (req.body.imageUrl !== undefined) about.imageUrl = assertOwnFileUrl(req.body.imageUrl);
  if (Array.isArray(req.body.gallery)) about.gallery = req.body.gallery.slice(0, 12).map((url) => assertOwnFileUrl(url));
  kitchen.about = about;
  await kitchen.save();
  await recordAudit(req, { action: "kitchen.about_changed", entityType: "kitchen", entityId: req.kitchenId, kitchenId: req.kitchenId, summary: "Updated the About page", diff: false });
  return ok(res, toKitchen(kitchen).about, "About page saved.");
}));

// Kitchen-level roles: built from the kitchen.* permissions only.
kitchenExtrasRouter.get("/roles", authorize("kitchen.team"), ownKitchen, asyncHandler(async (req, res) => {
  const roles = (await listRoles({ kitchenId: req.kitchenId })).filter((role) => role.scope === "kitchen" && role.slug !== "kitchen_admin");
  return ok(res, { roles, permissions: KITCHEN_PERMISSIONS }, "Kitchen roles fetched.");
}));
const kitchenRoleBody = [
  body("name").isString().trim().isLength({ min: 2, max: 60 }),
  body("description").optional().isString().isLength({ max: 200 }),
  body("permissions").isArray({ max: KITCHEN_PERMISSIONS.length }),
];
kitchenExtrasRouter.post("/roles", authorize("kitchen.roles"), ownKitchen, kitchenRoleBody, validate, asyncHandler(async (req, res) => {
  const permissions = [...new Set(["kitchen.desk", ...req.body.permissions])].filter((key) => key !== "kitchen.roles" && key !== "kitchen.team");
  const role = await createRole({ ...req.body, permissions, scope: "kitchen", kitchenId: req.kitchenId, actorId: req.auth.userId });
  await recordAudit(req, { action: "role.created", entityType: "role", entityId: role.slug, kitchenId: req.kitchenId, summary: `Created kitchen role ${role.name}`, diff: false, after: { permissions } });
  return ok(res, role, "Role created.", 201);
}));
kitchenExtrasRouter.patch("/roles/:slug", authorize("kitchen.roles"), ownKitchen, param("slug").matches(/^kitchen_[a-z0-9_]+$/), validate, asyncHandler(async (req, res) => {
  const role = await roleRepository.findBySlug(req.params.slug);
  if (!role || String(role.kitchen || "") !== req.kitchenId) throw new AppError(404, "Role not found");
  let data = await updateCustomRole(req.params.slug, req.body, { kitchenId: req.kitchenId });
  if (Array.isArray(req.body.permissions)) {
    const keys = [...new Set(["kitchen.desk", ...req.body.permissions])].filter((key) => key !== "kitchen.roles" && key !== "kitchen.team");
    data = await updateRolePermissions({ slug: req.params.slug, keys });
  }
  await recordAudit(req, { action: "role.updated", entityType: "role", entityId: data.slug, kitchenId: req.kitchenId, summary: `Updated kitchen role ${data.name}`, diff: false });
  return ok(res, data, "Role updated.");
}));
kitchenExtrasRouter.delete("/roles/:slug", authorize("kitchen.roles"), ownKitchen, param("slug").matches(/^kitchen_[a-z0-9_]+$/), validate, asyncHandler(async (req, res) => {
  const data = await deleteRole(req.params.slug, { kitchenId: req.kitchenId });
  await recordAudit(req, { action: "role.deleted", entityType: "role", entityId: req.params.slug, kitchenId: req.kitchenId, summary: "Deleted a kitchen role", diff: false });
  return ok(res, data, "Role deleted.");
}));
// Move a team member to another kitchen role (subadmin or a custom kitchen role).
kitchenExtrasRouter.patch("/staff/:userId/role", authorize("kitchen.team"), ownKitchen, param("userId").isMongoId(), body("roleSlug").matches(/^kitchen_[a-z0-9_]+$/), validate, asyncHandler(async (req, res) => {
  const member = await userRepository.findById(req.params.userId);
  if (!member || String(member.kitchen?._id || member.kitchen || "") !== req.kitchenId) throw new AppError(404, "Team member not found");
  if (member.role?.slug === "kitchen_admin" || req.body.roleSlug === "kitchen_admin") throw new AppError(403, "The kitchen admin is changed by MealJi");
  if (String(member._id) === req.auth.userId) throw new AppError(403, "You cannot change your own role");
  const role = await roleRepository.findBySlug(req.body.roleSlug);
  if (!role || (role.kitchen && String(role.kitchen) !== req.kitchenId) || role.scope !== "kitchen") throw new AppError(404, "Role not found");
  const before = member.role?.slug;
  const updated = await userRepository.updateById(member._id, { role: role._id });
  await recordAudit(req, { action: "user.role_changed", entityType: "user", entityId: String(member._id), kitchenId: req.kitchenId, summary: `${member.name}: ${before} to ${role.slug}`, before: { role: before }, after: { role: role.slug } });
  return ok(res, toPublicUser(updated), "Role changed.");
}));

// ------------------------------------------------------------------ platform console
export const adminKitchenExtrasRouter = Router();
adminKitchenExtrasRouter.use(authFor(["/kitchens", "/users"], authMiddleware));

adminKitchenExtrasRouter.put("/kitchens/:id/schedule", authorize("kitchens.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await saveSchedule(req, req.params.id, req.body), "Hours saved.")));
adminKitchenExtrasRouter.get("/kitchens/:id/roles", authorize("roles.read"), idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, (await listRoles({ kitchenId: req.params.id })).filter((role) => role.scope === "kitchen"), "Kitchen roles fetched.")
)));
adminKitchenExtrasRouter.get("/kitchens/:id/policies", authorize("kitchens.read"), idParam(), validate, asyncHandler(async (req, res) => {
  const keys = ["order_policy", "pricing", "tax", "delivery", "menu_policy"];
  const entries = await Promise.all(keys.map(async (key) => [key, (await resolveSetting(key, { kitchenId: req.params.id })).values]));
  return ok(res, Object.fromEntries(entries), "Effective policies.");
}));
adminKitchenExtrasRouter.get("/users/:id/addresses", authorize("users.read"), idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, (await Address.find({ user: req.params.id }).sort({ isDefault: -1, updatedAt: -1 }).lean()).map((address) => ({ ...toAddress(address), deleted: Boolean(address.deletedAt) })), "Addresses fetched.")
)));
