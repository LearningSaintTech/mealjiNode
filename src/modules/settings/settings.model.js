import mongoose from "mongoose";

// One document per saved version of one setting group at one scope. Versions
// are never edited. Future-dated versions are "scheduled" and can be cancelled
// until they start.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    scopeType: { type: String, enum: ["global", "city", "kitchen"], required: true },
    scopeId: { type: String, default: "" },
    version: { type: Number, required: true },
    // Only the fields this version changes (null = remove the override). The
    // values in force at a moment are all patches up to then, applied in
    // effectiveFrom order, so a scheduled change never leaks into earlier ones.
    patch: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Legacy full snapshot (versions saved before patches existed).
    values: { type: mongoose.Schema.Types.Mixed, default: undefined },
    effectiveFrom: { type: Date, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    createdBy: {
      userId: { type: String, default: null },
      name: { type: String, default: null },
      role: { type: String, default: null },
    },
    activationAnnounced: { type: Boolean, default: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

settingSchema.index({ key: 1, scopeType: 1, scopeId: 1, version: -1 }, { unique: true });
settingSchema.index({ key: 1, scopeType: 1, scopeId: 1, effectiveFrom: 1, version: 1 });
settingSchema.index({ activationAnnounced: 1, effectiveFrom: 1 });

export const Setting = mongoose.model("Setting", settingSchema);
