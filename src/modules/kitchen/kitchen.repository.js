import mongoose from "mongoose";
import { Kitchen, kitchenCache } from "./kitchen.model.js";

export const kitchenRepository = {
  async create(data) {
    return Kitchen.create(data);
  },

  async findById(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    return Kitchen.findById(id);
  },

  async findByPhone(phoneNumber) {
    return Kitchen.findOne({ phoneNumber });
  },

  async findByUserId(userId) {
    if (!mongoose.isValidObjectId(userId)) return null;
    return Kitchen.findOne({ user: userId });
  },

  async updateById(id, patch) {
    return Kitchen.findByIdAndUpdate(id, { $set: patch }, { new: true });
  },

  async deleteById(id) {
    await Kitchen.deleteOne({ _id: id });
  },

  async countByStatus() {
    return Kitchen.aggregate([
      {
        $group: {
          _id: "$status",
          total: { $sum: 1 },
          accepting: { $sum: { $cond: ["$acceptingOrders", 1, 0] } },
        },
      },
    ]);
  },

  // Cached for 5 s (cleared on kitchen writes): every customer request needs it.
  async listActiveLocated() {
    return kitchenCache.get("active", () => Kitchen.find({
      status: "active",
      latitude: { $type: "number" },
      longitude: { $type: "number" },
    }).lean());
  },

  /** An active kitchen from the cached list (falls back to the database). */
  async findActiveById(id) {
    const kitchens = await this.listActiveLocated();
    return kitchens.find((kitchen) => String(kitchen._id) === String(id)) || Kitchen.findById(id).lean();
  },

  async list({ status, phone, q, page, limit }) {
    const filter = {};
    if (status) filter.status = status;
    if (phone) filter.phoneNumber = { $regex: phone };
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { contactName: { $regex: q, $options: "i" } },
        { city: { $regex: q, $options: "i" } },
        { area: { $regex: q, $options: "i" } },
      ];
    }
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      Kitchen.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Kitchen.countDocuments(filter),
    ]);
    return { items, total };
  },
};
