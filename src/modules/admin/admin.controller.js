import { sendSuccess } from "../../common/responses/apiResponse.js";
import { recordAudit } from "../audit/audit.service.js";
import * as adminService from "./admin.service.js";

function roleSnapshot(role) {
  return role ? { permissions: (role.permissions || []).map((permission) => permission.key || permission).sort() } : null;
}

export async function createStaffController(req, res) {
  const data = await adminService.createStaff({ ...req.body, actor: req.auth });
  await recordAudit(req, {
    action: "staff.invited",
    entityType: "user",
    entityId: data.userId,
    summary: `Invited ${data.name} as ${data.role}`,
    after: { name: data.name, phoneNumber: data.phoneNumber, role: data.role },
    diff: false,
  });
  return sendSuccess(res, {
    status: 201,
    message: "Staff account created. They can sign in with OTP.",
    data,
  });
}

export async function listUsersController(req, res) {
  const data = await adminService.listUsers(req.query);
  return sendSuccess(res, { message: "Users fetched successfully.", data });
}

export async function getUserController(req, res) {
  const data = await adminService.getUser(req.params.userId);
  return sendSuccess(res, { message: "User fetched successfully.", data });
}

export async function updateStatusController(req, res) {
  const previous = await adminService.getUser(req.params.userId);
  const data = await adminService.updateUserStatus({
    actor: req.auth,
    userId: req.params.userId,
    isActive: req.body.isActive,
  });
  if (previous.isSuspended !== data.isSuspended) {
    await recordAudit(req, {
      action: data.isSuspended ? "user.suspended" : "user.activated",
      entityType: "user",
      entityId: data.userId,
      summary: `${data.isSuspended ? "Suspended" : "Activated"} ${data.name}`,
      before: { isSuspended: previous.isSuspended, isActive: previous.isActive },
      after: { isSuspended: data.isSuspended, isActive: data.isActive },
    });
  }
  return sendSuccess(res, { message: "User status updated successfully.", data });
}

export async function updateRoleController(req, res) {
  const previous = await adminService.getUser(req.params.userId);
  const data = await adminService.updateUserRole({
    actor: req.auth,
    userId: req.params.userId,
    roleSlug: req.body.roleSlug,
  });
  if (previous.role !== data.role) await recordAudit(req, {
    action: "user.role_changed",
    entityType: "user",
    entityId: data.userId,
    summary: `${data.name}: ${previous.role} to ${data.role}`,
    before: { role: previous.role },
    after: { role: data.role },
  });
  return sendSuccess(res, { message: "User role updated successfully.", data });
}

export async function statsController(req, res) {
  const data = await adminService.getStats(req.auth);
  return sendSuccess(res, { message: "Stats fetched successfully.", data });
}

export async function listRolesController(req, res) {
  const data = await adminService.listRoles({ kitchenId: req.query.kitchenId || null });
  return sendSuccess(res, { message: "Roles fetched successfully.", data });
}

export async function createRoleController(req, res) {
  const data = await adminService.createRole({ ...req.body, kitchenId: req.body.kitchenId || null, actorId: req.auth.userId });
  await recordAudit(req, {
    action: "role.created",
    entityType: "role",
    entityId: data.slug,
    summary: `Created ${data.scope} role ${data.name}`,
    after: { name: data.name, scope: data.scope, ...roleSnapshot(data) },
    kitchenId: data.kitchenId,
    diff: false,
  });
  return sendSuccess(res, { status: 201, message: "Role created.", data });
}

export async function updateRoleMetaController(req, res) {
  const previous = await adminService.getRole(req.params.slug);
  const data = await adminService.updateCustomRole(req.params.slug, req.body);
  await recordAudit(req, {
    action: "role.updated",
    entityType: "role",
    entityId: data.slug,
    summary: `Renamed role ${data.name}`,
    before: previous && { name: previous.name, description: previous.description },
    after: { name: data.name, description: data.description },
    kitchenId: data.kitchenId,
  });
  return sendSuccess(res, { message: "Role updated.", data });
}

export async function deleteRoleController(req, res) {
  const previous = await adminService.getRole(req.params.slug);
  const data = await adminService.deleteRole(req.params.slug);
  await recordAudit(req, {
    action: "role.deleted",
    entityType: "role",
    entityId: req.params.slug,
    summary: `Deleted role ${previous?.name || req.params.slug}`,
    before: previous && { name: previous.name, ...roleSnapshot(previous) },
    kitchenId: previous?.kitchenId,
    diff: false,
  });
  return sendSuccess(res, { message: "Role deleted.", data });
}

export async function updateRolePermissionsController(req, res) {
  const previous = await adminService.getRole(req.params.slug);
  const data = await adminService.updateRolePermissions({
    slug: req.params.slug,
    keys: req.body.permissions,
  });
  await recordAudit(req, {
    action: "role.permissions_changed",
    entityType: "role",
    entityId: req.params.slug,
    summary: `Changed permissions of ${req.params.slug}`,
    before: roleSnapshot(previous),
    after: roleSnapshot(data),
  });
  return sendSuccess(res, { message: "Role permissions updated successfully.", data });
}

export async function resetRolePermissionsController(req, res) {
  const previous = await adminService.getRole(req.params.slug);
  const data = await adminService.resetRolePermissions(req.params.slug);
  await recordAudit(req, {
    action: "role.permissions_reset",
    entityType: "role",
    entityId: req.params.slug,
    summary: `Reset ${req.params.slug} to default permissions`,
    before: roleSnapshot(previous),
    after: roleSnapshot(data),
  });
  return sendSuccess(res, { message: "Role permissions reset to defaults.", data });
}

export async function listPermissionsController(req, res) {
  const data = await adminService.listPermissions();
  return sendSuccess(res, { message: "Permissions fetched successfully.", data });
}
