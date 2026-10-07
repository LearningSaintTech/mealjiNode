import mongoose from "mongoose";

// Platform-set limits on what kitchens may override in one setting group:
// `fields.<fieldKey> = { kitchenEditable, min, max }`. One document per group.
const settingLimitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    fields: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: {
      userId: { type: String, default: null },
      name: { type: String, default: null },
    },
  },
  { timestamps: true, minimize: false },
);

export const SettingLimit = mongoose.model("SettingLimit", settingLimitSchema);
