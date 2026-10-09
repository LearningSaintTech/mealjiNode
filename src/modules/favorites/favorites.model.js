import mongoose from "mongoose";

const favoriteSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    dish: { type: mongoose.Schema.Types.ObjectId, ref: "KitchenDish", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
favoriteSchema.index({ user: 1, dish: 1 }, { unique: true });
favoriteSchema.index({ user: 1, createdAt: -1 });
export const Favorite = mongoose.model("Favorite", favoriteSchema);
