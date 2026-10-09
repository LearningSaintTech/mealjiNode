import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { KitchenCategory, KitchenDish } from "../catalog/catalog.model.js";
import { toDish } from "../catalog/catalog.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { resolveCustomerKitchen } from "../serviceability/serviceability.service.js";
import { Favorite } from "./favorites.model.js";

export { Favorite };

const router = Router();
router.use(authFor(["/me/favorites"], authMiddleware));

// A dish customers may see: active, approved and not in a hidden category.
async function visibleDish(dishId) {
  const dish = await KitchenDish.findOne({ _id: dishId, isActive: true, approvalStatus: "live" }).lean();
  if (!dish) return null;
  if (dish.category && !(await KitchenCategory.exists({ _id: dish.category, isActive: true }))) return null;
  return dish;
}

/** The kitchen that delivers to the user now (null when none does). */
async function servingKitchenId(req) {
  try {
    const { kitchen } = await resolveCustomerKitchen({
      kitchenId: req.query.kitchenId || null,
      latitude: req.query.latitude != null ? Number(req.query.latitude) : null,
      longitude: req.query.longitude != null ? Number(req.query.longitude) : null,
      userId: req.auth.userId, user: req.auth.user,
    });
    return String(kitchen._id);
  } catch {
    return null;
  }
}

router.get(
  "/me/favorites",
  query("kitchenId").optional({ values: "falsy" }).isMongoId(),
  query("latitude").optional().isFloat({ min: -90, max: 90 }),
  query("longitude").optional().isFloat({ min: -180, max: 180 }),
  validate,
  asyncHandler(async (req, res) => {
    const rows = await Favorite.find({ user: req.auth.userId }).sort({ createdAt: -1 }).limit(200).lean();
    const dishes = await KitchenDish.find({ _id: { $in: rows.map((row) => row.dish) }, isActive: true, approvalStatus: "live" }).lean();
    const hidden = new Set((await KitchenCategory.find({ _id: { $in: dishes.map((dish) => dish.category).filter(Boolean) }, isActive: false }).select("_id").lean()).map((row) => String(row._id)));
    const kitchens = new Map((await Kitchen.find({ _id: { $in: dishes.map((dish) => dish.kitchen) } }).select("name area").lean()).map((kitchen) => [String(kitchen._id), kitchen]));
    const here = await servingKitchenId(req);
    const byId = new Map(dishes.map((dish) => [String(dish._id), dish]));
    const items = rows
      .map((row) => byId.get(String(row.dish)))
      .filter((dish) => dish && !(dish.category && hidden.has(String(dish.category))))
      .map((dish) => {
        const view = toDish(dish);
        const kitchen = kitchens.get(view.kitchenId);
        // orderableHere: from the kitchen that delivers to the user, and orderable right now.
        return { ...view, isFavorite: true, kitchenName: kitchen?.name || null, kitchenArea: kitchen?.area || null, fromServingKitchen: view.kitchenId === here, orderableHere: view.kitchenId === here && view.isAvailable };
      });
    return ok(res, items, "Favourites fetched.");
  }),
);
router.post("/me/favorites", body("dishId").isMongoId().withMessage("dishId is not valid"), validate, asyncHandler(async (req, res) => {
  const dish = await visibleDish(req.body.dishId);
  if (!dish) throw new AppError(404, "Dish not found");
  const result = await Favorite.updateOne({ user: req.auth.userId, dish: dish._id }, { $setOnInsert: { user: req.auth.userId, dish: dish._id } }, { upsert: true });
  const created = Boolean(result.upsertedCount);
  if (created) await publishEventSafe("favorite.added", { userId: req.auth.userId, dishId: String(dish._id) });
  // 201 the first time, 200 when it was already a favourite (safe to repeat).
  return ok(res, { dishId: String(dish._id), isFavorite: true }, created ? "Added to favourites." : "Already in favourites.", created ? 201 : 200);
}));
router.delete("/me/favorites/:dishId", param("dishId").isMongoId().withMessage("dishId is not valid"), validate, asyncHandler(async (req, res) => {
  await Favorite.deleteOne({ user: req.auth.userId, dish: req.params.dishId });
  return ok(res, { dishId: req.params.dishId, isFavorite: false }, "Removed from favourites.");
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1/users", recordMountPath, router);
}
