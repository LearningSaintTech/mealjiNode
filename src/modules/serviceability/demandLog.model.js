import mongoose from "mongoose";

// Every "not serviceable" check, for the expansion demand report.
const demandLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    pincode: { type: String, default: null },
    city: { type: String, default: null },
    source: { type: String, default: "location" },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

demandLogSchema.index({ createdAt: -1 });
demandLogSchema.index({ pincode: 1, createdAt: -1 });

export const DemandLog = mongoose.model("DemandLog", demandLogSchema);
