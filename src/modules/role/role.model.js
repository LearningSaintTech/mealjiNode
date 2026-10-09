import mongoose from "mongoose";

const roleSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    // platform | kitchen | customer – which console the role signs in to.
    scope: { type: String, enum: ["platform", "kitchen", "customer"], default: "platform" },
    isSystem: { type: Boolean, default: true },
    customized: { type: Boolean, default: false },
    // A kitchen-level custom role belongs to one kitchen; null for platform roles.
    kitchen: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    permissions: [{ type: mongoose.Schema.Types.ObjectId, ref: "Permission" }],
  },
  { timestamps: true },
);

roleSchema.index({ kitchen: 1 }, { sparse: true });

// Role edits clear the sign-in role cache (user.repository.js) in this process.
const roleCacheClear = async () => (await import("../user/user.repository.js")).roleCache.clear();
roleSchema.post("save", roleCacheClear);
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany"]) roleSchema.post(op, roleCacheClear);

export const Role = mongoose.model("Role", roleSchema);
