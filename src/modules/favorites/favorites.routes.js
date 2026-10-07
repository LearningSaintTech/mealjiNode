import mongoose from "mongoose";
import { Router } from "express";
import { body, param } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { KitchenDish } from "../catalog/catalog.model.js";
import { toDish } from "../catalog/catalog.service.js";

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

const router = Router();
router.use(authFor(["/me/favorites"], authMiddleware));

router.get("/me/favorites", asyncHandler(async (req, res) => {
  const rows = await Favorite.find({ user: req.auth.userId }).sort({ createdAt: -1 }).limit(200).lean();
  const dishes = await KitchenDish.find({ _id: { $in: rows.map((row) => row.dish) } }).lean();
  const byId = new Map(dishes.map((dish) => [String(dish._id), dish]));
  const items = rows.map((row) => byId.get(String(row.dish))).filter((dish) => dish && dish.isActive).map((dish) => ({ ...toDish(dish), isFavorite: true }));
  return ok(res, items, "Favourites fetched.");
}));
router.post("/me/favorites", body("dishId").isMongoId(), validate, asyncHandler(async (req, res) => {
  const dish = await KitchenDish.findOne({ _id: req.body.dishId, isActive: true }).lean();
  if (!dish) throw new AppError(404, "Dish not found");
  await Favorite.updateOne({ user: req.auth.userId, dish: dish._id }, { $setOnInsert: { user: req.auth.userId, dish: dish._id } }, { upsert: true });
  await publishEventSafe("favorite.added", { userId: req.auth.userId, dishId: String(dish._id) });
  return ok(res, { dishId: String(dish._id), isFavorite: true }, "Added to favourites.", 201);
}));
router.delete("/me/favorites/:dishId", param("dishId").isMongoId(), validate, asyncHandler(async (req, res) => {
  await Favorite.deleteOne({ user: req.auth.userId, dish: req.params.dishId });
  return ok(res, { dishId: req.params.dishId, isFavorite: false }, "Removed from favourites.");
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1/users", recordMountPath, router);
}
