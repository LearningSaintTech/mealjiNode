import { Role } from "./role.model.js";

const permissionPopulate = { path: "permissions" };

export const roleRepository = {
  async findBySlug(slug) {
    return Role.findOne({ slug }).populate(permissionPopulate);
  },

  async findById(id) {
    return Role.findById(id).populate(permissionPopulate);
  },

  async list(filter = {}) {
    return Role.find(filter).sort({ isSystem: -1, slug: 1 }).populate(permissionPopulate);
  },

  async create(doc) {
    const role = await Role.create(doc);
    return Role.findById(role._id).populate(permissionPopulate);
  },

  async update(slug, patch) {
    return Role.findOneAndUpdate({ slug }, { $set: patch }, { new: true }).populate(permissionPopulate);
  },

  async remove(slug) {
    return Role.deleteOne({ slug, isSystem: false });
  },

  async upsertSystemRole({ slug, name, description, scope, permissionIds, lockedIds = [] }) {
    const existing = await Role.findOne({ slug }).select("customized");
    if (existing?.customized) {
      return Role.findOneAndUpdate(
        { slug },
        { $set: { name, description, scope, isSystem: true }, $addToSet: { permissions: { $each: lockedIds } } },
        { new: true },
      );
    }
    return Role.findOneAndUpdate(
      { slug },
      {
        $set: {
          name,
          description,
          scope,
          isSystem: true,
          customized: false,
          permissions: permissionIds,
        },
      },
      { upsert: true, new: true },
    );
  },

  async setPermissions(slug, permissionIds, customized) {
    return Role.findOneAndUpdate(
      { slug },
      { $set: { permissions: permissionIds, customized } },
      { new: true },
    ).populate(permissionPopulate);
  },
};
