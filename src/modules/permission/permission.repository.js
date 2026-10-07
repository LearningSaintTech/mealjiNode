import { Permission } from "./permission.model.js";

export const permissionRepository = {
  async upsertByKey(permission) {
    return Permission.findOneAndUpdate(
      { key: permission.key },
      { $set: permission },
      { upsert: true, new: true },
    );
  },

  async list() {
    return Permission.find().sort({ module: 1, key: 1 }).lean();
  },

  async findByKeys(keys) {
    return Permission.find({ key: { $in: keys } });
  },
};
