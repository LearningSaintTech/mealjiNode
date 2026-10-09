import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, has, idParam, ok, ownKitchen, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { resolveCustomerKitchen } from "../serviceability/serviceability.service.js";
import * as catalog from "./catalog.service.js";

const actorOf = (req) => ({ userId: req.auth.userId, name: req.auth.user?.name || null });

/**
 * The menu management routes, shared by the kitchen console (own kitchen,
 * kitchen.* permissions, subject to the approval policy) and the platform
 * console (any kitchen, menu.manage, applied directly).
 */
function menuManagementRoutes({ platform }) {
  const router = Router({ mergeParams: true });
  const kitchenOf = (req) => (platform ? req.params.kitchenId : req.kitchenId);
  const edit = platform ? authorize("menu.manage") : authorize("kitchen.menu");
  const read = platform ? authorize("kitchens.read") : (req, res, next) => next();
  const availability = platform ? authorize("menu.manage") : authorize("kitchen.availability");
  const audit = (req, action, summary, extra = {}) => recordAudit(req, { action, entityType: "menu", kitchenId: kitchenOf(req), summary, ...extra });

  router.get("/categories", read, asyncHandler(async (req, res) => ok(res, await catalog.listCategories(kitchenOf(req)), "Categories fetched.")));
  router.post("/categories", edit, asyncHandler(async (req, res) => {
    const data = await catalog.createCategory(kitchenOf(req), req.body);
    await audit(req, "menu.category_created", `Added category ${data.name}`, { entityId: data.categoryId, after: data, diff: false });
    return ok(res, data, "Category added.", 201);
  }));
  router.put("/categories/order", edit, body("order").isArray({ max: 100 }), validate, asyncHandler(async (req, res) => (
    ok(res, await catalog.reorderCategories(kitchenOf(req), req.body.order), "Categories reordered.")
  )));
  router.patch("/categories/:id", edit, idParam(), validate, asyncHandler(async (req, res) => {
    const { before, after } = await catalog.updateCategory(kitchenOf(req), req.params.id, req.body);
    await audit(req, "menu.category_updated", `Updated category ${after.name}`, { entityId: after.categoryId, before, after });
    return ok(res, after, "Category updated.");
  }));
  router.delete("/categories/:id", edit, idParam(), validate, asyncHandler(async (req, res) => {
    const data = await catalog.deleteCategory(kitchenOf(req), req.params.id);
    await audit(req, "menu.category_deleted", `Deleted category ${data.name}`, { entityId: data.categoryId, diff: false });
    return ok(res, data, "Category deleted.");
  }));

  router.get(
    "/dishes",
    read,
    query("categoryId").optional({ values: "falsy" }).isMongoId(),
    query("status").optional().isIn(["active", "archived", "pending", "sold_out", "all"]),
    query("q").optional().isString().isLength({ max: 60 }),
    validate,
    asyncHandler(async (req, res) => ok(res, await catalog.listKitchenDishes(kitchenOf(req), req.query), "Dishes fetched.")),
  );
  router.get("/dishes/:id", read, idParam(), validate, asyncHandler(async (req, res) => (
    ok(res, catalog.toDishAdmin(await catalog.getKitchenDish(kitchenOf(req), req.params.id)), "Dish fetched.")
  )));
  router.post("/dishes", edit, asyncHandler(async (req, res) => {
    const data = await catalog.createDish(kitchenOf(req), req.body, { actor: actorOf(req), platform });
    await audit(req, "menu.dish_created", `Added dish ${data.dish.name}${data.pendingApproval ? " (waiting for approval)" : ""}`, { entityId: data.dish.dishId, after: { name: data.dish.name, pricePaise: data.dish.pricePaise }, diff: false });
    return ok(res, data, data.pendingApproval ? "Dish saved. It goes live once MealJi approves it." : "Dish added.", 201);
  }));
  router.patch("/dishes/:id", edit, idParam(), validate, asyncHandler(async (req, res) => {
    const canChangePrices = platform || has(req, "kitchen.menu.prices");
    const data = await catalog.updateDish(kitchenOf(req), req.params.id, req.body, { actor: actorOf(req), platform, canChangePrices });
    const pick = (dish) => ({ name: dish.name, pricePaise: dish.pricePaise, isActive: dish.isActive, isAvailable: dish.isAvailable, categoryId: dish.categoryId });
    await audit(req, "menu.dish_updated", `Updated dish ${data.after.name}${data.pendingApproval ? ` (${data.pendingFields.join(", ")} waiting for approval)` : ""}`, { entityId: data.after.dishId, before: pick(data.before), after: pick(data.after), reason: req.body.changeReason || null });
    return ok(res, data, data.pendingApproval ? "Saved. Some changes go live once MealJi approves them." : "Dish updated.");
  }));
  router.patch(
    "/dishes/:id/availability",
    availability,
    idParam(),
    body("isAvailable").optional().isBoolean(),
    body("dailyStockLimit").optional().isInt({ min: 0, max: 100000 }).toInt(),
    validate,
    asyncHandler(async (req, res) => {
      const data = await catalog.setDishAvailability(kitchenOf(req), req.params.id, req.body);
      await audit(req, "menu.availability_changed", `${data.dish.name}: ${data.after.isAvailable ? "back in stock" : "sold out"}`, { entityId: data.dish.dishId, before: data.before, after: data.after });
      return ok(res, data.dish, data.after.isAvailable ? "Back in stock." : "Marked sold out.");
    }),
  );
  router.delete("/dishes/:id", edit, idParam(), validate, asyncHandler(async (req, res) => {
    const data = await catalog.deleteDish(kitchenOf(req), req.params.id);
    await audit(req, data.archived ? "menu.dish_archived" : "menu.dish_deleted", `${data.archived ? "Archived" : "Deleted"} dish ${data.name}`, { entityId: data.dishId, diff: false });
    return ok(res, data, data.archived ? "Dish has orders, so it was archived instead." : "Dish deleted.");
  }));
  router.post(
    "/import-master",
    edit,
    body("masterDishIds").isArray({ min: 1, max: 100 }),
    body("masterDishIds.*").isMongoId(),
    body("categoryId").optional({ values: "null" }).isMongoId(),
    validate,
    asyncHandler(async (req, res) => {
      const data = await catalog.importMasterDishes(kitchenOf(req), req.body, { actor: actorOf(req), platform });
      await audit(req, "menu.imported", `Imported ${data.imported} dish(es) from the master library`, { diff: false, after: { dishes: data.dishes.map((dish) => dish.name) } });
      return ok(res, data, `Imported ${data.imported} dish(es).`, 201);
    }),
  );

  router.get("/combos", read, asyncHandler(async (req, res) => ok(res, await catalog.listCombos(kitchenOf(req)), "Combos fetched.")));
  router.post("/combos", edit, asyncHandler(async (req, res) => {
    const data = await catalog.createCombo(kitchenOf(req), req.body, { actor: actorOf(req), platform });
    await audit(req, "menu.combo_created", `Added combo ${data.combo.title}`, { entityId: data.combo.comboId, diff: false, after: { title: data.combo.title, pricePaise: data.combo.pricePaise } });
    return ok(res, data, "Combo added.", 201);
  }));
  router.patch("/combos/:id", edit, idParam(), validate, asyncHandler(async (req, res) => {
    const data = await catalog.updateCombo(kitchenOf(req), req.params.id, req.body, { actor: actorOf(req), platform, canChangePrices: platform || has(req, "kitchen.menu.prices") });
    await audit(req, "menu.combo_updated", `Updated combo ${data.after.title}`, { entityId: data.after.comboId, before: { pricePaise: data.before.pricePaise, isActive: data.before.isActive }, after: { pricePaise: data.after.pricePaise, isActive: data.after.isActive } });
    return ok(res, data, "Combo updated.");
  }));
  router.delete("/combos/:id", edit, idParam(), validate, asyncHandler(async (req, res) => {
    const data = await catalog.deleteCombo(kitchenOf(req), req.params.id);
    await audit(req, "menu.combo_deleted", `Deleted combo ${data.title}`, { entityId: data.comboId, diff: false });
    return ok(res, data, "Combo deleted.");
  }));

  router.get("/requests", read, pageQuery, query("status").optional().isIn(["pending", "approved", "rejected", "superseded", "all"]), validate, asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query);
    return ok(res, await catalog.listChangeRequests({ status: req.query.status || "all", kitchenId: kitchenOf(req), page, limit }), "Requests fetched.");
  }));

  return router;
}

// /api/v1/kitchen/menu – own kitchen.
export const kitchenMenuRouter = Router();
kitchenMenuRouter.use(authMiddleware, authorize("kitchen.desk"), ownKitchen, menuManagementRoutes({ platform: false }));

// /api/v1/admin/kitchens/:kitchenId/menu – any kitchen.
export const adminKitchenMenuRouter = Router({ mergeParams: true });
adminKitchenMenuRouter.use(authMiddleware, param("kitchenId").isMongoId().withMessage("Invalid kitchen ID"), validate, menuManagementRoutes({ platform: true }));

// /api/v1/admin – master library and approvals.
export const adminCatalogRouter = Router();
adminCatalogRouter.use(authMiddleware);
adminCatalogRouter.get("/master-categories", authorize("master_menu.manage"), asyncHandler(async (req, res) => ok(res, await catalog.listMasterCategories(), "Master categories fetched.")));
adminCatalogRouter.post("/master-categories", authorize("master_menu.manage"), asyncHandler(async (req, res) => ok(res, await catalog.saveMasterCategory(null, req.body), "Category added.", 201)));
adminCatalogRouter.patch("/master-categories/:id", authorize("master_menu.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await catalog.saveMasterCategory(req.params.id, req.body), "Category updated.")));
adminCatalogRouter.delete("/master-categories/:id", authorize("master_menu.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await catalog.deleteMasterCategory(req.params.id), "Category deleted.")));
// Kitchens browse the library to import from it.
const libraryRead = (req, res, next) => (has(req, "master_menu.manage") || has(req, "menu.manage") || has(req, "kitchen.menu") ? next() : next(new AppError(403, "You do not have permission to perform this action")));
adminCatalogRouter.get("/master-dishes", libraryRead, pageQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query, { defaultLimit: 50 });
  return ok(res, await catalog.listMasterDishes({ ...req.query, page, limit }), "Master dishes fetched.");
}));
adminCatalogRouter.post("/master-dishes", authorize("master_menu.manage"), asyncHandler(async (req, res) => {
  const data = await catalog.saveMasterDish(null, req.body);
  await recordAudit(req, { action: "master_menu.dish_created", entityType: "master_dish", entityId: data.masterDishId, summary: `Added ${data.name} to the master library`, diff: false });
  return ok(res, data, "Master dish added.", 201);
}));
adminCatalogRouter.patch("/master-dishes/:id", authorize("master_menu.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const data = await catalog.saveMasterDish(req.params.id, req.body);
  await recordAudit(req, { action: "master_menu.dish_updated", entityType: "master_dish", entityId: data.masterDishId, summary: `Updated master dish ${data.name}`, diff: false });
  return ok(res, data, "Master dish updated.");
}));
adminCatalogRouter.delete("/master-dishes/:id", authorize("master_menu.manage"), idParam(), query("hard").optional().isBoolean().toBoolean(), validate, asyncHandler(async (req, res) => (
  req.query.hard ? ok(res, await catalog.purgeMasterDish(req.params.id), "Master dish deleted.") : ok(res, await catalog.deleteMasterDish(req.params.id), "Master dish archived.")
)));

adminCatalogRouter.get(
  "/menu-change-requests",
  authorize("menu_changes.approve"),
  pageQuery,
  query("status").optional().isIn(["pending", "approved", "rejected", "superseded", "all"]),
  query("kitchenId").optional({ values: "falsy" }).isMongoId(),
  validate,
  asyncHandler(async (req, res) => {
    const { page, limit } = paging(req.query);
    return ok(res, await catalog.listChangeRequests({ status: req.query.status || "pending", kitchenId: req.query.kitchenId, page, limit }), "Requests fetched.");
  }),
);
adminCatalogRouter.post(
  "/menu-change-requests/:id/:decision",
  authorize("menu_changes.approve"),
  idParam(),
  param("decision").isIn(["approve", "reject"]),
  body("note").optional({ values: "null" }).isString().isLength({ max: 300 }),
  validate,
  asyncHandler(async (req, res) => {
    const approve = req.params.decision === "approve";
    const data = await catalog.reviewChangeRequest(req.params.id, { approve, note: req.body.note || null, reviewer: actorOf(req) });
    await recordAudit(req, { action: approve ? "menu_change.approved" : "menu_change.rejected", entityType: "menu_change_request", entityId: data.requestId, kitchenId: data.kitchenId, summary: `${approve ? "Approved" : "Rejected"} ${data.action} of ${data.entityName}`, reason: req.body.note || null, diff: false, after: data.changes });
    return ok(res, data, approve ? "Approved and live." : "Rejected.");
  }),
);

// /api/v1 – customer menu for the kitchen that serves them.
export const customerCatalogRouter = Router();
customerCatalogRouter.use(authFor(["/menu", "/combos", "/dishes"], authMiddleware));

async function servingKitchen(req) {
  const { kitchen } = await resolveCustomerKitchen({
    kitchenId: req.query.kitchenId || null,
    latitude: req.query.latitude != null ? Number(req.query.latitude) : null,
    longitude: req.query.longitude != null ? Number(req.query.longitude) : null,
    userId: req.auth.userId,
  });
  return String(kitchen._id);
}

const kitchenQuery = [
  query("kitchenId").optional({ values: "falsy" }).isMongoId(),
  query("latitude").optional().isFloat({ min: -90, max: 90 }),
  query("longitude").optional().isFloat({ min: -180, max: 180 }),
];

customerCatalogRouter.get("/menu/categories", kitchenQuery, validate, asyncHandler(async (req, res) => ok(res, await catalog.customerCategories(await servingKitchen(req)), "Categories fetched.")));
customerCatalogRouter.get(
  "/menu",
  kitchenQuery,
  query("categoryId").optional({ values: "falsy" }).isMongoId(),
  query("sort").optional().isIn(["relevance", "popular", "rating", "price_asc", "price_desc"]),
  query("q").optional().isString().isLength({ max: 60 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await catalog.customerMenu(await servingKitchen(req), req.query), "Menu fetched.")),
);
customerCatalogRouter.get("/menu/popular", kitchenQuery, validate, asyncHandler(async (req, res) => ok(res, await catalog.popularDishes(await servingKitchen(req)), "Popular dishes fetched.")));
customerCatalogRouter.get("/menu/items/:id", kitchenQuery, idParam(), validate, asyncHandler(async (req, res) => ok(res, await catalog.customerDish(await servingKitchen(req), req.params.id), "Dish fetched.")));
customerCatalogRouter.get("/menu/items/:id/recommendations", kitchenQuery, idParam(), validate, asyncHandler(async (req, res) => ok(res, await catalog.recommendations(await servingKitchen(req), req.params.id), "Recommendations fetched.")));
customerCatalogRouter.get("/combos", kitchenQuery, validate, asyncHandler(async (req, res) => ok(res, await catalog.customerCombos(await servingKitchen(req)), "Combos fetched.")));
customerCatalogRouter.get("/combos/signature", kitchenQuery, validate, asyncHandler(async (req, res) => ok(res, await catalog.customerCombos(await servingKitchen(req), { signature: true }), "Signature combos fetched.")));
customerCatalogRouter.get(
  "/dishes",
  kitchenQuery,
  query("page").optional().isInt({ min: 1, max: 1000 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  query("veg").optional().isBoolean(),
  query("sort").optional().isIn(["popular", "price_asc", "price_desc", "rating", "prep_time"]).withMessage("sort: popular, price_asc, price_desc, rating or prep_time"),
  validate,
  asyncHandler(async (req, res) => {
    const menu = await catalog.customerMenu(await servingKitchen(req), req.query);
    // Sorted as asked across all categories (or menu order when no sort is given).
    const all = req.query.sort ? menu.dishes : menu.categories.flatMap((category) => category.dishes);
    // Paged when `limit` is sent (page 1 by default); the whole list otherwise.
    const limit = req.query.limit || null;
    const page = limit ? req.query.page || 1 : 1;
    const items = limit ? all.slice((page - 1) * limit, page * limit) : all;
    return ok(res, { kitchen: menu.kitchen, items, total: all.length, page, limit: limit || all.length, hasMore: limit ? page * limit < all.length : false }, "Dishes fetched.");
  }),
);
customerCatalogRouter.get("/dishes/filters", kitchenQuery, validate, asyncHandler(async (req, res) => ok(res, await catalog.dishFilters(await servingKitchen(req)), "Filters fetched.")));
