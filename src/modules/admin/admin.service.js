import { AppError } from "../../common/errors/AppError.js";
import { escapeRegex } from "../../common/text.util.js";
import crypto from "node:crypto";
import {
  LOCKED_GRANTS,
  ROLE_GRANTS,
  assignablePermissions,
  isPlatformRole,
  roleScope,
} from "../../constants/permissions.js";
import { countryOrDefault, normalizeMobile } from "../../common/phone.util.js";
import { kitchenRepository } from "../kitchen/kitchen.repository.js";
import { roleRepository } from "../role/role.repository.js";
import { permissionRepository } from "../permission/permission.repository.js";
import { toPublicUser } from "../user/user.mapper.js";
import { userRepository } from "../user/user.repository.js";
import { isSuspended, reinstatePatch, suspendPatch } from "../user/user.status.js";
import { storeDel, storeSetNx } from "../../infrastructure/redisStore.js";

// Serialises changes that could remove the last active super admin, so two
// admins demoting or suspending each other at once cannot both succeed.
async function withSuperAdminGuard(work) {
  const lock = "lock:superadmin-guard";
  if (!(await storeSetNx(lock, "1", 15))) {
    throw new AppError(409, "Another admin change is in progress. Try again in a moment.");
  }
  try {
    return await work();
  } finally {
    await storeDel(lock).catch(() => {});
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createStaff({ actor, name, countryCode, phoneNumber, roleSlug }) {
  const role = await roleRepository.findBySlug(roleSlug);
  if (!role || !isPlatformRole(role)) throw new AppError(400, "Choose a platform staff role");
  if (role.slug === "superadmin" && actor?.role !== "superadmin") {
    throw new AppError(403, "Only a super admin can invite another super admin");
  }

  const phone = normalizeMobile(phoneNumber);
  const code = countryOrDefault(countryCode);
  const existing = await userRepository.findByPhone(code, phone);
  if (existing) {
    throw new AppError(409, "An account with this phone number already exists");
  }

  const user = await userRepository.create({
    name: name.trim(),
    countryCode: code,
    phoneNumber: phone,
    role: role._id,
    isActive: false,
    isNumberVerified: false,
  });
  return toPublicUser(user);
}

export async function listUsers(query) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  let roleId;
  if (query.role) {
    const role = await roleRepository.findBySlug(query.role);
    if (!role) return { items: [], page, limit, total: 0 };
    roleId = role._id;
  }

  const { items, total } = await userRepository.list({
    roleId,
    kitchenId: query.kitchenId,
    status: query.status,
    phone: query.phone,
    q: query.q ? escapeRegex(query.q.trim()) : "",
    page,
    limit,
  });

  return {
    items: items.map(toPublicUser),
    page,
    limit,
    total,
  };
}

export async function getUser(userId) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(404, "User not found");
  return toPublicUser(user);
}

export async function updateUserStatus({ actor, userId, isActive }) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (String(user._id) === actor.userId) {
    throw new AppError(403, "You cannot change the status of your own account");
  }
  if (user.role?.slug === "superadmin" && actor.role !== "superadmin") {
    throw new AppError(403, "You cannot change a super admin account");
  }
  // Suspension is its own flag, so an invited account can be suspended too and
  // its first OTP sign-in will not undo it.
  const suspend = isActive === false;
  if (isSuspended(user) === suspend) {
    return toPublicUser(user);
  }

  const apply = async () => {
    if (suspend && user.role?.slug === "superadmin" && user.isActive) {
      const activeAdmins = await userRepository.countActiveByRole(user.role._id);
      if (activeAdmins <= 1) {
        throw new AppError(409, "Cannot suspend the last active super admin");
      }
    }
    return userRepository.updateById(user._id, suspend ? suspendPatch() : reinstatePatch(user));
  };
  const updated = user.role?.slug === "superadmin" && suspend ? await withSuperAdminGuard(apply) : await apply();
  return toPublicUser(updated);
}

export async function updateUserRole({ actor, userId, roleSlug }) {
  const user = await userRepository.findById(userId);
  if (!user) throw new AppError(404, "User not found");
  if (String(user._id) === actor.userId) {
    throw new AppError(403, "You cannot change your own role");
  }
  if (!isPlatformRole(user.role)) {
    throw new AppError(400, "Only platform staff roles can be changed here");
  }

  const nextRole = await roleRepository.findBySlug(roleSlug);
  if (!nextRole || !isPlatformRole(nextRole)) {
    throw new AppError(400, "Choose a platform staff role");
  }
  if (actor.role !== "superadmin" && (roleSlug === "superadmin" || user.role.slug === "superadmin")) {
    throw new AppError(403, "Only a super admin can grant or remove the super admin role");
  }
  if (user.role.slug === roleSlug) {
    return toPublicUser(user);
  }

  const apply = async () => {
    if (user.role.slug === "superadmin" && user.isActive) {
      const activeAdmins = await userRepository.countActiveByRole(user.role._id);
      if (activeAdmins <= 1) {
        throw new AppError(409, "Cannot change the role of the last active super admin");
      }
    }
    return userRepository.updateById(user._id, { role: nextRole._id });
  };
  const updated = user.role.slug === "superadmin" ? await withSuperAdminGuard(apply) : await apply();
  return toPublicUser(updated);
}

export async function getStats(actor) {
  const roles = await roleRepository.list();
  const slugById = new Map(roles.map((role) => [String(role._id), role.slug]));
  const empty = () => ({ total: 0, active: 0, suspended: 0, invited: 0 });
  const users = Object.fromEntries(roles.filter((role) => !role.kitchen).map((role) => [role.slug, empty()]));

  for (const row of await userRepository.countByRoleAndState()) {
    const slug = slugById.get(String(row._id));
    if (!slug || !users[slug]) continue;
    users[slug] = {
      total: row.total,
      active: row.active,
      suspended: row.suspended,
      invited: row.invited,
    };
  }

  const userRole = roles.find((role) => role.slug === "user");
  const newCustomers7d = userRole
    ? await userRepository.countCreatedSince(userRole._id, new Date(Date.now() - 7 * DAY_MS))
    : 0;

  let kitchens = null;
  if (actor.permissions.includes("kitchens.read")) {
    kitchens = { total: 0, onboarding: 0, active: 0, paused: 0, acceptingOrders: 0 };
    for (const row of await kitchenRepository.countByStatus()) {
      if (!(row._id in kitchens)) continue;
      kitchens[row._id] = row.total;
      kitchens.total += row.total;
      kitchens.acceptingOrders += row.accepting;
    }
  }

  return { users, newCustomers7d, kitchens };
}

function toPublicRole(role) {
  return {
    slug: role.slug,
    name: role.name,
    description: role.description,
    scope: roleScope(role),
    isSystem: role.isSystem !== false,
    kitchenId: role.kitchen ? String(role.kitchen._id || role.kitchen) : null,
    customized: Boolean(role.customized),
    assignable: assignablePermissions(role),
    locked: LOCKED_GRANTS[role.slug] || [],
    permissions: (role.permissions || []).map((permission) => ({
      key: permission.key,
      module: permission.module,
      description: permission.description,
    })),
  };
}

export { toPublicRole };

export async function getRole(slug) {
  const role = await roleRepository.findBySlug(slug);
  return role ? toPublicRole(role) : null;
}

// Platform consoles see every platform, customer and system kitchen role, plus
// kitchen-level custom roles only when asked for a kitchen.
export async function listRoles({ kitchenId = null } = {}) {
  const filter = kitchenId ? { $or: [{ kitchen: null }, { kitchen: kitchenId }] } : { kitchen: null };
  const roles = await roleRepository.list(filter);
  return roles.map(toPublicRole);
}

function slugFor(scope, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "role";
  return `${scope === "kitchen" ? "kitchen" : "staff"}_${base}_${crypto.randomBytes(3).toString("hex")}`;
}

async function permissionIdsFor(role, keys) {
  const wanted = [...new Set(keys || [])];
  const assignable = assignablePermissions(role);
  const outside = wanted.filter((key) => !assignable.includes(key));
  if (outside.length) throw new AppError(400, `${role.name || "This role"} cannot hold: ${outside.join(", ")}`);
  const permissions = await permissionRepository.findByKeys(wanted);
  if (permissions.length !== wanted.length) throw new AppError(400, "One or more permissions do not exist");
  return permissions.map((permission) => permission._id);
}

/**
 * Creates a custom role. Platform roles (scope "platform") are created by the
 * platform admin; kitchen roles are created either by the platform admin for a
 * kitchen or by a kitchen admin for their own kitchen (`kitchenId` set).
 */
export async function createRole({ name, description, scope, permissions, kitchenId = null, actorId = null }) {
  if (!["platform", "kitchen"].includes(scope)) throw new AppError(400, "scope must be platform or kitchen");
  if (scope === "platform" && kitchenId) throw new AppError(400, "A platform role cannot belong to a kitchen");
  const draft = { name: name.trim(), scope };
  const ids = await permissionIdsFor(draft, permissions);
  const role = await roleRepository.create({
    slug: slugFor(scope, name),
    name: name.trim(),
    description: (description || "").trim() || `Custom ${scope} role`,
    scope,
    isSystem: false,
    customized: true,
    kitchen: kitchenId,
    createdBy: actorId,
    permissions: ids,
  });
  return toPublicRole(role);
}

export async function updateCustomRole(slug, { name, description }, { kitchenId = null } = {}) {
  const role = await roleRepository.findBySlug(slug);
  if (!role || (kitchenId && String(role.kitchen || "") !== String(kitchenId))) throw new AppError(404, "Role not found");
  if (role.isSystem) throw new AppError(400, "System roles keep their name");
  const patch = {};
  if (name != null) patch.name = String(name).trim();
  if (description != null) patch.description = String(description).trim();
  return toPublicRole(await roleRepository.update(slug, patch));
}

export async function deleteRole(slug, { kitchenId = null } = {}) {
  const role = await roleRepository.findBySlug(slug);
  if (!role || (kitchenId && String(role.kitchen || "") !== String(kitchenId))) throw new AppError(404, "Role not found");
  if (role.isSystem) throw new AppError(400, "System roles cannot be deleted");
  const members = await userRepository.countByRole(role._id);
  if (members > 0) throw new AppError(409, `Move the ${members} member(s) to another role before deleting it`);
  await roleRepository.remove(slug);
  return { slug, deleted: true };
}

export async function updateRolePermissions({ slug, keys }) {
  const role = await roleRepository.findBySlug(slug);
  if (!role) throw new AppError(404, "Role not found");

  const wanted = [...new Set(keys)];
  const assignable = assignablePermissions(role);
  const outside = wanted.filter((key) => !assignable.includes(key));
  if (outside.length) {
    throw new AppError(400, `${role.name} cannot hold: ${outside.join(", ")}`);
  }
  const missingLocked = (LOCKED_GRANTS[slug] || []).filter((key) => !wanted.includes(key));
  if (missingLocked.length) {
    throw new AppError(409, `${role.name} must keep: ${missingLocked.join(", ")}`);
  }

  const permissions = await permissionRepository.findByKeys(wanted);
  if (permissions.length !== wanted.length) {
    throw new AppError(400, "One or more permissions do not exist");
  }

  const updated = await roleRepository.setPermissions(slug, permissions.map((permission) => permission._id), true);
  return toPublicRole(updated);
}

export async function resetRolePermissions(slug) {
  const role = await roleRepository.findBySlug(slug);
  if (!role) throw new AppError(404, "Role not found");
  if (!role.isSystem) throw new AppError(400, "Custom roles have no defaults to reset to");
  const permissions = await permissionRepository.findByKeys(ROLE_GRANTS[slug] || []);
  const updated = await roleRepository.setPermissions(slug, permissions.map((permission) => permission._id), false);
  return toPublicRole(updated);
}

export async function listPermissions() {
  const permissions = await permissionRepository.list();
  return permissions.map((permission) => ({
    key: permission.key,
    module: permission.module,
    description: permission.description,
  }));
}
