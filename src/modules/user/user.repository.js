import mongoose from "mongoose";
import { memoCache } from "../../common/memoCache.js";
import { Role } from "../role/role.model.js";
import { User } from "./user.model.js";

const rolePopulate = {
  path: "role",
  populate: { path: "permissions" },
};

// Roles and their permissions change rarely and are read on every request:
// cached 30 s per role (cleared on role writes in this process).
export const roleCache = memoCache(30_000);
const roleWithPermissions = (roleId) => roleCache.get(String(roleId), () => Role.findById(roleId).populate("permissions"));

export const userRepository = {
  /** For sign-in checks on every request: one user read, role from the cache. */
  async findForAuth(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    const user = await User.findById(id);
    if (user?.role) {
      const role = await roleWithPermissions(user.role);
      if (role) user.role = role;
    }
    return user;
  },

  async findById(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    return User.findById(id).populate(rolePopulate);
  },

  async findByPhone(countryCode, phoneNumber) {
    const exact = await User.findOne({ countryCode, phoneNumber }).populate(rolePopulate);
    if (exact) return exact;
    return User.findOne({ phoneNumber }).populate(rolePopulate);
  },

  async create(data) {
    const user = await User.create(data);
    return this.findById(user._id);
  },

  async updateById(id, patch) {
    await User.updateOne({ _id: id }, { $set: patch });
    return this.findById(id);
  },

  async list({ roleId, kitchenId, status, phone, q, page, limit }) {
    const filter = {};
    if (roleId) filter.role = roleId;
    if (kitchenId) filter.kitchen = kitchenId;
    // Same rules as user.status.js: suspension is its own flag; older records
    // that are verified but inactive also count as suspended.
    if (status === "active") Object.assign(filter, { isNumberVerified: true, isActive: true, suspendedAt: null });
    if (status === "suspended") filter.$or = [{ suspendedAt: { $ne: null } }, { isNumberVerified: true, isActive: false }];
    if (status === "invited") Object.assign(filter, { isNumberVerified: false, suspendedAt: null });
    if (phone) filter.phoneNumber = { $regex: phone };
    if (q) filter.name = { $regex: q, $options: "i" };
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      User.find(filter).populate(rolePopulate).sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(filter),
    ]);
    return { items, total };
  },

  async listByKitchen(kitchenId) {
    return User.find({ kitchen: kitchenId }).populate(rolePopulate).sort({ createdAt: 1 });
  },

  async countByRole(roleId) {
    return User.countDocuments({ role: roleId });
  },

  async countActiveByRole(roleId) {
    return User.countDocuments({ role: roleId, isActive: true });
  },

  async countByRoleAndState() {
    return User.aggregate([
      {
        $group: {
          _id: "$role",
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $and: ["$isNumberVerified", "$isActive", { $not: [{ $ifNull: ["$suspendedAt", false] }] }] }, 1, 0] } },
          suspended: { $sum: { $cond: [{ $or: [{ $ifNull: ["$suspendedAt", false] }, { $and: ["$isNumberVerified", { $not: ["$isActive"] }] }] }, 1, 0] } },
          invited: { $sum: { $cond: [{ $or: ["$isNumberVerified", { $ifNull: ["$suspendedAt", false] }] }, 0, 1] } },
        },
      },
    ]);
  },

  async countCreatedSince(roleId, since) {
    return User.countDocuments({ role: roleId, createdAt: { $gte: since } });
  },
};
