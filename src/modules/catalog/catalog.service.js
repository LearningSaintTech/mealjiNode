import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { escapeRegex } from "../../common/text.util.js";
import { istDateKey, istParts } from "../../common/time.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { storeDel, storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { KitchenCategory, KitchenCombo, KitchenDish, MasterCategory, MasterDish, MenuChangeRequest } from "./catalog.model.js";
import { gatedFields, normalizeCategory, normalizeCombo, normalizeDish } from "./catalog.normalize.js";
import { memoCache } from "../../common/memoCache.js";

const MENU_TTL_SEC = 120;
const menuKey = (kitchenId) => `menu:${kitchenId}`;

// ---------------------------------------------------------------- mappers

export function stockLeft(dish, at = new Date()) {
  if (!dish.dailyStockLimit) return null;
  const sold = dish.stock?.date === istDateKey(at) ? dish.stock.sold || 0 : 0;
  return Math.max(0, dish.dailyStockLimit - sold);
}

// When each on-demand meal slot can be ordered (IST, minutes from midnight).
// A dish with availableSlots is orderable only inside one of its windows.
export const DISH_SLOT_HOURS = {
  breakfast: { from: 7 * 60, to: 11 * 60, label: "Breakfast (7–11 am)" },
  lunch: { from: 11 * 60, to: 16 * 60, label: "Lunch (11 am–4 pm)" },
  snacks: { from: 16 * 60, to: 19 * 60, label: "Snacks (4–7 pm)" },
  dinner: { from: 19 * 60, to: 23 * 60 + 30, label: "Dinner (7–11:30 pm)" },
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function inSlot(slots, at) {
  if (!slots?.length) return true;
  const { hour, minute } = istParts(at);
  const now = hour * 60 + minute;
  return slots.some((slot) => DISH_SLOT_HOURS[slot] && now >= DISH_SLOT_HOURS[slot].from && now < DISH_SLOT_HOURS[slot].to);
}

/**
 * Why a dish cannot be ordered right now, or null when it can:
 * unavailable (not live / switched off), not_today, outside_slot, sold_out.
 */
export function unavailableReason(dish, at = new Date()) {
  if (!dish || !dish.isActive || dish.approvalStatus !== "live" || !dish.isAvailable) return "unavailable";
  if (dish.availableDays?.length && !dish.availableDays.includes(istParts(at).weekday)) return "not_today";
  if (!inSlot(dish.availableSlots, at)) return "outside_slot";
  const left = stockLeft(dish, at);
  return left == null || left > 0 ? null : "sold_out";
}

/** Text for the app when a dish cannot be ordered now. */
export function unavailableMessage(dish, reason) {
  if (reason === "sold_out") return "Sold out for today";
  if (reason === "not_today") return `Available on ${dish.availableDays.map((day) => WEEKDAYS[day]).join(", ")}`;
  if (reason === "outside_slot") return `Available for ${dish.availableSlots.map((slot) => DISH_SLOT_HOURS[slot]?.label || slot).join(", ")}`;
  if (reason === "unavailable") return "Currently unavailable";
  return null;
}

/** Can this dish be ordered right now (kitchen switches, approval, day, meal slot, stock)? */
export function isOrderable(dish, at = new Date()) {
  return unavailableReason(dish, at) === null;
}

export function toDish(dish, at = new Date()) {
  const reason = unavailableReason(dish, at);
  return {
    dishId: String(dish._id),
    kitchenId: String(dish.kitchen),
    categoryId: dish.category ? String(dish.category) : null,
    name: dish.name,
    description: dish.description || "",
    story: dish.story || "",
    images: dish.images || [],
    imageUrl: dish.images?.[0] || null,
    pricePaise: dish.pricePaise,
    originalPricePaise: dish.originalPricePaise ?? null,
    isVeg: dish.isVeg !== false,
    isAvailable: reason === null,
    // Why it cannot be ordered now (null when it can): unavailable | not_today | outside_slot | sold_out.
    unavailableReason: reason,
    unavailableMessage: unavailableMessage(dish, reason),
    stockLeft: stockLeft(dish, at),
    isBestseller: Boolean(dish.isBestseller),
    badge: dish.badge ?? null,
    spicyLevel: dish.spicyLevel || 0,
    calories: dish.calories ?? null,
    preparationMinutes: dish.preparationMinutes ?? null,
    servesCount: dish.servesCount || 1,
    highlights: dish.highlights || [],
    tags: dish.tags || [],
    cuisine: dish.cuisine ?? null,
    portions: (dish.portions || []).map((portion) => ({ portionId: portion.portionId, label: portion.label, pricePaise: portion.pricePaise, serves: portion.serves || null, isDefault: Boolean(portion.isDefault) })),
    // “Make it a meal”: pricePaise is added to the dish price when chosen.
    mealUpgrade: dish.mealUpgrade?.label ? {
      label: dish.mealUpgrade.label,
      description: dish.mealUpgrade.description || null,
      pricePaise: dish.mealUpgrade.pricePaise || 0,
      originalPricePaise: dish.mealUpgrade.originalPricePaise ?? null,
      savingsPaise: dish.mealUpgrade.originalPricePaise > dish.mealUpgrade.pricePaise ? dish.mealUpgrade.originalPricePaise - dish.mealUpgrade.pricePaise : 0,
      imageUrl: dish.mealUpgrade.imageUrl || null,
    } : null,
    customizationGroups: (dish.customizationGroups || []).map(toGroup),
    availableSlots: dish.availableSlots || [],
    availableDays: dish.availableDays || [],
    // Standard name (same as kitchens): ratingAvg. `rating` is kept for older clients.
    ratingAvg: Math.round((dish.ratingAvg || 0) * 10) / 10,
    rating: Math.round((dish.ratingAvg || 0) * 10) / 10,
    ratingCount: dish.ratingCount || 0,
  };
}

/** Option group as the app needs it: required, single or multi choice, limits. */
function toGroup(group) {
  const minSelect = group.minSelect || 0;
  const maxSelect = Math.max(group.maxSelect || 1, minSelect || 1);
  return {
    groupId: group.groupId,
    name: group.name,
    required: minSelect > 0,
    multiple: maxSelect > 1,
    minSelect,
    maxSelect,
    options: (group.options || []).map((option) => ({ optionId: option.optionId, name: option.name, pricePaise: option.pricePaise || 0, isVeg: option.isVeg !== false, isAvailable: option.isAvailable !== false })),
  };
}

export function toDishAdmin(dish) {
  return {
    ...toDish(dish),
    isAvailable: Boolean(dish.isAvailable),
    orderableNow: isOrderable(dish),
    isActive: Boolean(dish.isActive),
    approvalStatus: dish.approvalStatus,
    packagingPaise: dish.packagingPaise || 0,
    dailyStockLimit: dish.dailyStockLimit || 0,
    availableDays: dish.availableDays || [],
    sortOrder: dish.sortOrder || 0,
    masterDishId: dish.masterDish ? String(dish.masterDish) : null,
    orderCount: dish.orderCount || 0,
    updatedAt: dish.updatedAt,
  };
}

export function toCategory(category, counts = null) {
  return {
    categoryId: String(category._id),
    name: category.name,
    icon: category.icon ?? null,
    subtitle: category.subtitle ?? null,
    imageUrl: category.imageUrl ?? null,
    sortOrder: category.sortOrder || 0,
    isActive: category.isActive !== false,
    ...(counts ? { dishCount: counts.get(String(category._id)) || 0 } : {}),
  };
}

export function toCombo(combo, dishesById = new Map(), at = new Date()) {
  const items = (combo.items || []).map((item) => {
    const dish = dishesById.get(String(item.dish));
    return {
      dishId: String(item.dish),
      qty: item.qty,
      name: dish?.name || null,
      imageUrl: dish?.images?.[0] || null,
      pricePaise: dish?.pricePaise ?? null,
      isVeg: dish ? dish.isVeg !== false : true,
    };
  });
  // “Save ₹X”: against the stated original price, else the dishes bought one by one.
  const itemsTotal = items.every((item) => item.pricePaise != null) ? items.reduce((sum, item) => sum + item.pricePaise * item.qty, 0) : null;
  const compareAt = combo.originalPricePaise || itemsTotal;
  const savingsPaise = compareAt && compareAt > combo.pricePaise ? compareAt - combo.pricePaise : 0;
  const allOrderable = items.every((item) => {
    const dish = dishesById.get(item.dishId);
    return dish ? isOrderable(dish, at) : false;
  });
  return {
    comboId: String(combo._id),
    kitchenId: String(combo.kitchen),
    // Standard names across dish/combo/plan: name, servesCount, originalPricePaise.
    // title/serves are kept for older clients and the console.
    name: combo.title,
    title: combo.title,
    subtitle: combo.subtitle ?? null,
    imageUrl: combo.imageUrl ?? null,
    pricePaise: combo.pricePaise,
    originalPricePaise: combo.originalPricePaise ?? null,
    itemsTotalPaise: itemsTotal,
    savingsPaise,
    badge: combo.badge ?? null,
    servesCount: combo.serves || 1,
    serves: combo.serves || 1,
    items,
    isVeg: items.every((item) => item.isVeg),
    filterTags: combo.filterTags || [],
    isSignature: Boolean(combo.isSignature),
    isAvailable: Boolean(combo.isActive && combo.isAvailable && combo.approvalStatus === "live" && allOrderable),
    isActive: Boolean(combo.isActive),
    approvalStatus: combo.approvalStatus,
    sortOrder: combo.sortOrder || 0,
  };
}

/** A combo for customers: no approval/console fields. */
export function toCustomerCombo(combo, dishesById, at = new Date()) {
  const { isActive, approvalStatus, sortOrder, ...view } = toCombo(combo, dishesById, at);
  return view;
}

function toRequest(request) {
  return {
    requestId: String(request._id),
    kitchenId: String(request.kitchen?._id || request.kitchen),
    kitchenName: request.kitchen?.name || null,
    entityType: request.entityType,
    entityId: String(request.entityId),
    entityName: request.entityName,
    action: request.action,
    changes: request.changes,
    before: request.before,
    reason: request.reason,
    requestedBy: request.requestedBy,
    status: request.status,
    reviewedBy: request.reviewedBy?.userId ? request.reviewedBy : null,
    reviewNote: request.reviewNote,
    reviewedAt: request.reviewedAt,
    createdAt: request.createdAt,
  };
}

// ---------------------------------------------------------------- cache

export async function invalidateMenu(kitchenId, reason = "changed") {
  localMenus.clear(String(kitchenId));
  await storeDel(menuKey(kitchenId)).catch(() => {});
  await publishEventSafe("catalog.changed", { kitchenId: String(kitchenId), reason }, { aggregate: { type: "kitchen", id: kitchenId } });
}

async function requireKitchen(kitchenId) {
  const kitchen = await Kitchen.findById(objectId(kitchenId, "kitchen ID")).lean();
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  return kitchen;
}

async function menuPolicy(kitchenId) {
  return (await resolveSetting("menu_policy", { kitchenId })).values;
}

function checkImages(images) {
  return (images || []).map((url) => assertOwnFileUrl(url, "Dish image"));
}

// ---------------------------------------------------------------- categories

export async function listCategories(kitchenId) {
  const [categories, counts] = await Promise.all([
    KitchenCategory.find({ kitchen: kitchenId }).sort({ sortOrder: 1, name: 1 }).lean(),
    KitchenDish.aggregate([{ $match: { kitchen: objectId(kitchenId), isActive: true } }, { $group: { _id: "$category", total: { $sum: 1 } } }]),
  ]);
  const byCategory = new Map(counts.map((row) => [String(row._id), row.total]));
  return categories.map((category) => toCategory(category, byCategory));
}

export async function createCategory(kitchenId, input) {
  await requireKitchen(kitchenId);
  const data = normalizeCategory(input);
  if (data.imageUrl) data.imageUrl = assertOwnFileUrl(data.imageUrl);
  const category = await KitchenCategory.create({ ...data, kitchen: kitchenId });
  await invalidateMenu(kitchenId, "category");
  return toCategory(category);
}

export async function updateCategory(kitchenId, categoryId, input) {
  const category = await KitchenCategory.findOne({ _id: objectId(categoryId, "category ID"), kitchen: kitchenId });
  if (!category) throw new AppError(404, "Category not found");
  const before = toCategory(category);
  Object.assign(category, normalizeCategory(input, { partial: true }));
  await category.save();
  await invalidateMenu(kitchenId, "category");
  return { before, after: toCategory(category) };
}

export async function deleteCategory(kitchenId, categoryId) {
  const category = await KitchenCategory.findOne({ _id: objectId(categoryId, "category ID"), kitchen: kitchenId });
  if (!category) throw new AppError(404, "Category not found");
  const dishes = await KitchenDish.countDocuments({ category: category._id, isActive: true });
  if (dishes) throw new AppError(409, `Move or archive the ${dishes} dish(es) in this category first`);
  await KitchenCategory.deleteOne({ _id: category._id });
  await KitchenDish.updateMany({ category: category._id }, { $set: { category: null } });
  await invalidateMenu(kitchenId, "category");
  return { categoryId: String(category._id), deleted: true, name: category.name };
}

export async function reorderCategories(kitchenId, order) {
  const ops = (order || []).map((id, index) => ({ updateOne: { filter: { _id: objectId(id, "category ID"), kitchen: kitchenId }, update: { $set: { sortOrder: index } } } }));
  if (ops.length) await KitchenCategory.bulkWrite(ops);
  await invalidateMenu(kitchenId, "category");
  return listCategories(kitchenId);
}

// ---------------------------------------------------------------- dishes

export async function listKitchenDishes(kitchenId, { categoryId, q, status } = {}) {
  const filter = { kitchen: kitchenId };
  if (categoryId) filter.category = objectId(categoryId, "category ID");
  if (q) filter.name = { $regex: escapeRegex(q), $options: "i" };
  if (status === "archived") filter.isActive = false;
  else if (status === "pending") filter.approvalStatus = "pending";
  else if (status === "sold_out") Object.assign(filter, { isActive: true, isAvailable: false });
  else if (status !== "all") filter.isActive = true;
  const dishes = await KitchenDish.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  return dishes.map(toDishAdmin);
}

export async function getKitchenDish(kitchenId, dishId) {
  const dish = await KitchenDish.findOne({ _id: objectId(dishId, "dish ID"), kitchen: kitchenId });
  if (!dish) throw new AppError(404, "Dish not found");
  return dish;
}

async function assertCategory(kitchenId, categoryId) {
  if (!categoryId) return null;
  const category = await KitchenCategory.findOne({ _id: objectId(categoryId, "category ID"), kitchen: kitchenId }).lean();
  if (!category) throw new AppError(422, "Validation failed", [{ field: "categoryId", message: "Category not found in this kitchen" }]);
  return category._id;
}

function requester(actor) {
  return { userId: actor?.userId || null, name: actor?.name || null };
}

/**
 * Creates a dish. A kitchen admin's new dish waits for approval when the menu
 * policy asks for it (it is saved but hidden until approved); platform staff
 * changes always apply directly.
 */
export async function createDish(kitchenId, input, { actor, platform = false } = {}) {
  await requireKitchen(kitchenId);
  const policy = await menuPolicy(kitchenId);
  if (!platform && !policy.kitchenCanCreateDishes) throw new AppError(403, "New dishes are added by the MealJi team for this kitchen");
  const data = normalizeDish(input, { maxImages: policy.maxDishImages });
  data.images = checkImages(data.images);
  data.category = await assertCategory(kitchenId, input.categoryId);
  const needsApproval = !platform && gatedFields(policy.menuChangeApproval, data, { creating: true }).length > 0;
  const dish = await KitchenDish.create({ ...data, kitchen: kitchenId, approvalStatus: needsApproval ? "pending" : "live" });
  if (needsApproval) {
    await MenuChangeRequest.create({ kitchen: kitchenId, entityType: "dish", entityId: dish._id, entityName: dish.name, action: "create", changes: data, requestedBy: requester(actor) });
    await publishEventSafe("menu_change.requested", { kitchenId: String(kitchenId), entityType: "dish", entityId: String(dish._id) });
  }
  await invalidateMenu(kitchenId, "dish");
  return { dish: toDishAdmin(dish), pendingApproval: needsApproval };
}

export async function updateDish(kitchenId, dishId, input, { actor, platform = false, canChangePrices = true } = {}) {
  const dish = await getKitchenDish(kitchenId, dishId);
  const policy = await menuPolicy(kitchenId);
  const data = normalizeDish(input, { partial: true, maxImages: policy.maxDishImages });
  if (data.images) data.images = checkImages(data.images);
  if (input.categoryId !== undefined) data.category = await assertCategory(kitchenId, input.categoryId);
  if (!platform && !canChangePrices) {
    const priceKeys = Object.keys(data).filter((key) => ["pricePaise", "originalPricePaise", "packagingPaise", "portions", "customizationGroups", "mealUpgrade"].includes(key));
    if (priceKeys.length) throw new AppError(403, "Your role cannot change prices");
  }
  const before = toDishAdmin(dish);
  const gated = platform || dish.approvalStatus === "pending" ? [] : gatedFields(policy.menuChangeApproval, data);
  const immediate = Object.fromEntries(Object.entries(data).filter(([key]) => !gated.includes(key)));
  Object.assign(dish, immediate);
  // Editing a dish that is still waiting for approval updates the pending request too.
  if (dish.approvalStatus === "pending" && !platform) {
    await MenuChangeRequest.updateOne({ entityId: dish._id, status: "pending", action: "create" }, { $set: { changes: { ...data } } });
  }
  await dish.save();
  let request = null;
  if (gated.length) {
    const changes = Object.fromEntries(gated.map((key) => [key, data[key]]));
    const beforeGated = Object.fromEntries(gated.map((key) => [key, dish.toObject()[key] ?? null]));
    await MenuChangeRequest.updateMany({ entityId: dish._id, status: "pending", action: "update" }, { $set: { status: "superseded" } });
    request = await MenuChangeRequest.create({ kitchen: kitchenId, entityType: "dish", entityId: dish._id, entityName: dish.name, action: "update", changes, before: beforeGated, reason: input.changeReason || null, requestedBy: requester(actor) });
    await publishEventSafe("menu_change.requested", { kitchenId: String(kitchenId), entityType: "dish", entityId: String(dish._id) });
  }
  await invalidateMenu(kitchenId, "dish");
  return { before, after: toDishAdmin(dish), pendingApproval: Boolean(request), pendingFields: gated };
}

export async function setDishAvailability(kitchenId, dishId, { isAvailable, dailyStockLimit }) {
  const dish = await getKitchenDish(kitchenId, dishId);
  const before = { isAvailable: dish.isAvailable, dailyStockLimit: dish.dailyStockLimit };
  if (typeof isAvailable === "boolean") dish.isAvailable = isAvailable;
  if (Number.isInteger(dailyStockLimit) && dailyStockLimit >= 0) dish.dailyStockLimit = dailyStockLimit;
  await dish.save();
  await invalidateMenu(kitchenId, "availability");
  if (before.isAvailable && !dish.isAvailable) {
    await publishEventSafe("dish.sold_out", { kitchenId: String(kitchenId), dishId: String(dish._id), name: dish.name });
  }
  return { before, after: { isAvailable: dish.isAvailable, dailyStockLimit: dish.dailyStockLimit }, dish: toDishAdmin(dish) };
}

export async function deleteDish(kitchenId, dishId) {
  const dish = await getKitchenDish(kitchenId, dishId);
  if (dish.orderCount > 0) {
    dish.isActive = false;
    await dish.save();
    await invalidateMenu(kitchenId, "dish");
    return { dishId: String(dish._id), archived: true, name: dish.name };
  }
  await KitchenDish.deleteOne({ _id: dish._id });
  await KitchenCombo.updateMany({ kitchen: kitchenId }, { $pull: { items: { dish: dish._id } } });
  await MenuChangeRequest.updateMany({ entityId: dish._id, status: "pending" }, { $set: { status: "superseded" } });
  await invalidateMenu(kitchenId, "dish");
  return { dishId: String(dish._id), deleted: true, name: dish.name };
}

/** Copies master library dishes into a kitchen's menu (content + suggested price). */
export async function importMasterDishes(kitchenId, { masterDishIds, categoryId }, { actor, platform = false } = {}) {
  await requireKitchen(kitchenId);
  const category = await assertCategory(kitchenId, categoryId);
  const masters = await MasterDish.find({ _id: { $in: (masterDishIds || []).map((id) => objectId(id, "master dish ID")) }, isActive: true }).lean();
  if (!masters.length) throw new AppError(404, "No master dishes found");
  const created = [];
  for (const master of masters) {
    const { _id, createdAt, updatedAt, __v, suggestedPricePaise, category: masterCategory, isActive, ...content } = master;
    const existing = await KitchenDish.findOne({ kitchen: kitchenId, masterDish: _id }).lean();
    if (existing) continue;
    const result = await createDish(kitchenId, { ...content, pricePaise: suggestedPricePaise || 0, categoryId: category ? String(category) : null }, { actor, platform });
    await KitchenDish.updateOne({ _id: result.dish.dishId }, { $set: { masterDish: _id } });
    created.push({ ...result.dish, masterDishId: String(_id) });
  }
  return { imported: created.length, dishes: created };
}

// ---------------------------------------------------------------- combos

async function dishesMap(kitchenId) {
  const dishes = await KitchenDish.find({ kitchen: kitchenId }).lean();
  return new Map(dishes.map((dish) => [String(dish._id), dish]));
}

async function assertComboDishes(kitchenId, items) {
  const ids = items.map((item) => objectId(item.dish, "dish ID"));
  const found = await KitchenDish.countDocuments({ _id: { $in: ids }, kitchen: kitchenId });
  if (found !== new Set(ids.map(String)).size) throw new AppError(422, "Validation failed", [{ field: "items", message: "Every combo dish must be on this kitchen's menu" }]);
}

export async function listCombos(kitchenId, { includeInactive = true } = {}) {
  const [combos, dishes] = await Promise.all([
    KitchenCombo.find({ kitchen: kitchenId, ...(includeInactive ? {} : { isActive: true }) }).sort({ sortOrder: 1 }).lean(),
    dishesMap(kitchenId),
  ]);
  return combos.map((combo) => toCombo(combo, dishes));
}

export async function createCombo(kitchenId, input, { actor, platform = false } = {}) {
  await requireKitchen(kitchenId);
  const policy = await menuPolicy(kitchenId);
  const data = normalizeCombo(input);
  if (data.imageUrl) data.imageUrl = assertOwnFileUrl(data.imageUrl);
  await assertComboDishes(kitchenId, data.items);
  const needsApproval = !platform && gatedFields(policy.menuChangeApproval, data, { creating: true }).length > 0;
  const combo = await KitchenCombo.create({ ...data, kitchen: kitchenId, approvalStatus: needsApproval ? "pending" : "live" });
  if (needsApproval) {
    await MenuChangeRequest.create({ kitchen: kitchenId, entityType: "combo", entityId: combo._id, entityName: combo.title, action: "create", changes: data, requestedBy: requester(actor) });
  }
  await invalidateMenu(kitchenId, "combo");
  return { combo: toCombo(combo, await dishesMap(kitchenId)), pendingApproval: needsApproval };
}

export async function updateCombo(kitchenId, comboId, input, { actor, platform = false, canChangePrices = true } = {}) {
  const combo = await KitchenCombo.findOne({ _id: objectId(comboId, "combo ID"), kitchen: kitchenId });
  if (!combo) throw new AppError(404, "Combo not found");
  if (!platform && !canChangePrices && (input.pricePaise !== undefined || input.originalPricePaise !== undefined)) throw new AppError(403, "Your role cannot change prices");
  const policy = await menuPolicy(kitchenId);
  const data = normalizeCombo(input, { partial: true });
  if (data.items) await assertComboDishes(kitchenId, data.items);
  const priceGate = policy.menuChangeApproval === "price_changes" ? ["pricePaise", "originalPricePaise"] : null;
  const gated = platform || combo.approvalStatus === "pending" ? [] : policy.menuChangeApproval === "all"
    ? Object.keys(data)
    : priceGate ? Object.keys(data).filter((key) => priceGate.includes(key)) : [];
  const before = toCombo(combo);
  Object.assign(combo, Object.fromEntries(Object.entries(data).filter(([key]) => !gated.includes(key))));
  await combo.save();
  if (gated.length) {
    await MenuChangeRequest.create({ kitchen: kitchenId, entityType: "combo", entityId: combo._id, entityName: combo.title, action: "update", changes: Object.fromEntries(gated.map((key) => [key, data[key]])), requestedBy: requester(actor) });
  }
  await invalidateMenu(kitchenId, "combo");
  return { before, after: toCombo(combo, await dishesMap(kitchenId)), pendingApproval: gated.length > 0 };
}

export async function deleteCombo(kitchenId, comboId) {
  const combo = await KitchenCombo.findOneAndDelete({ _id: objectId(comboId, "combo ID"), kitchen: kitchenId });
  if (!combo) throw new AppError(404, "Combo not found");
  await invalidateMenu(kitchenId, "combo");
  return { comboId: String(combo._id), deleted: true, title: combo.title };
}

// ---------------------------------------------------------------- approvals

export async function listChangeRequests({ status = "pending", kitchenId = null, page = 1, limit = 25 }) {
  const filter = {};
  if (status && status !== "all") filter.status = status;
  if (kitchenId) filter.kitchen = objectId(kitchenId, "kitchen ID");
  const [items, total] = await Promise.all([
    MenuChangeRequest.find(filter).populate("kitchen", "name").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    MenuChangeRequest.countDocuments(filter),
  ]);
  return { items: items.map(toRequest), page, limit, total };
}

export async function reviewChangeRequest(requestId, { approve, note = null, reviewer }) {
  const request = await MenuChangeRequest.findById(objectId(requestId, "request ID"));
  if (!request) throw new AppError(404, "Request not found");
  if (request.status !== "pending") throw new AppError(409, `This request is already ${request.status}`);
  const Model = request.entityType === "dish" ? KitchenDish : KitchenCombo;
  const entity = await Model.findById(request.entityId);
  if (!entity) {
    request.status = "superseded";
    await request.save();
    throw new AppError(409, "The dish or combo no longer exists");
  }
  if (approve) {
    if (request.action === "create") entity.approvalStatus = "live";
    else Object.assign(entity, request.changes);
    await entity.save();
  } else if (request.action === "create") {
    entity.approvalStatus = "rejected";
    await entity.save();
  }
  request.status = approve ? "approved" : "rejected";
  request.reviewedBy = { userId: reviewer?.userId || null, name: reviewer?.name || null };
  request.reviewNote = note;
  request.reviewedAt = new Date();
  await request.save();
  await invalidateMenu(request.kitchen, "approval");
  await publishEventSafe(approve ? "menu_change.approved" : "menu_change.rejected", { kitchenId: String(request.kitchen), requestId: String(request._id), entityName: request.entityName });
  return toRequest(await MenuChangeRequest.findById(request._id).populate("kitchen", "name").lean());
}

// ---------------------------------------------------------------- master library

export async function listMasterCategories() {
  return (await MasterCategory.find().sort({ sortOrder: 1, name: 1 }).lean()).map((category) => toCategory(category));
}

export async function saveMasterCategory(categoryId, input) {
  const data = normalizeCategory(input, { partial: Boolean(categoryId) });
  if (!categoryId) return toCategory(await MasterCategory.create(data));
  const category = await MasterCategory.findByIdAndUpdate(objectId(categoryId, "category ID"), { $set: data }, { new: true });
  if (!category) throw new AppError(404, "Category not found");
  return toCategory(category);
}

export async function deleteMasterCategory(categoryId) {
  const used = await MasterDish.countDocuments({ category: objectId(categoryId, "category ID") });
  if (used) throw new AppError(409, `${used} master dish(es) use this category`);
  const deleted = await MasterCategory.findByIdAndDelete(categoryId);
  if (!deleted) throw new AppError(404, "Category not found");
  return { categoryId, deleted: true };
}

function toMasterDish(dish) {
  return {
    masterDishId: String(dish._id),
    categoryId: dish.category ? String(dish.category) : null,
    name: dish.name,
    description: dish.description,
    story: dish.story,
    images: dish.images || [],
    isVeg: dish.isVeg !== false,
    spicyLevel: dish.spicyLevel || 0,
    calories: dish.calories ?? null,
    servesCount: dish.servesCount || 1,
    highlights: dish.highlights || [],
    tags: dish.tags || [],
    cuisine: dish.cuisine ?? null,
    portions: dish.portions || [],
    customizationGroups: dish.customizationGroups || [],
    mealUpgrade: dish.mealUpgrade?.label ? dish.mealUpgrade : null,
    suggestedPricePaise: dish.suggestedPricePaise ?? null,
    isActive: dish.isActive !== false,
    updatedAt: dish.updatedAt,
  };
}

export async function listMasterDishes({ q, categoryId, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (q) filter.name = { $regex: escapeRegex(q), $options: "i" };
  if (categoryId) filter.category = objectId(categoryId, "category ID");
  const [items, total] = await Promise.all([
    MasterDish.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    MasterDish.countDocuments(filter),
  ]);
  const usage = await KitchenDish.aggregate([{ $match: { masterDish: { $in: items.map((item) => item._id) } } }, { $group: { _id: "$masterDish", kitchens: { $addToSet: "$kitchen" } } }]);
  const used = new Map(usage.map((row) => [String(row._id), row.kitchens.length]));
  return { items: items.map((item) => ({ ...toMasterDish(item), kitchensUsing: used.get(String(item._id)) || 0 })), page, limit, total };
}

export async function saveMasterDish(dishId, input) {
  const data = normalizeDish(input, { partial: Boolean(dishId), kitchenDish: false, maxImages: 10 });
  if (data.images) data.images = checkImages(data.images);
  if (input.categoryId !== undefined) data.category = input.categoryId ? objectId(input.categoryId, "category ID") : null;
  if (input.suggestedPricePaise !== undefined) data.suggestedPricePaise = Number.isInteger(input.suggestedPricePaise) ? input.suggestedPricePaise : null;
  if (input.isActive !== undefined) data.isActive = Boolean(input.isActive);
  if (!dishId) return toMasterDish(await MasterDish.create(data));
  const dish = await MasterDish.findByIdAndUpdate(objectId(dishId, "master dish ID"), { $set: data }, { new: true });
  if (!dish) throw new AppError(404, "Master dish not found");
  return toMasterDish(dish);
}

/** Removes a master dish for good, only when no kitchen menu was built from it. */
export async function purgeMasterDish(dishId) {
  const id = objectId(dishId, "master dish ID");
  const used = await KitchenDish.countDocuments({ masterDish: id });
  if (used) throw new AppError(409, `${used} kitchen dish(es) were imported from it; archive it instead`);
  const dish = await MasterDish.findByIdAndDelete(id);
  if (!dish) throw new AppError(404, "Master dish not found");
  return { masterDishId: dishId, deleted: true };
}

export async function deleteMasterDish(dishId) {
  const dish = await MasterDish.findByIdAndUpdate(objectId(dishId, "master dish ID"), { $set: { isActive: false } }, { new: true });
  if (!dish) throw new AppError(404, "Master dish not found");
  return { masterDishId: dishId, archived: true };
}

// ---------------------------------------------------------------- customer menu

/** The whole live menu of one kitchen (cached), from which every customer view is cut. */
// Parsed menus kept in memory for 10 s (on top of the 2-minute Redis copy), so
// busy menu/home/search traffic does not re-read and re-parse it every request.
const localMenus = memoCache(10_000);

/** The kitchen's live menu (cached); concurrent callers share one load. */
export function kitchenMenu(kitchenId) {
  return localMenus.get(String(kitchenId), () => loadKitchenMenu(kitchenId));
}

async function loadKitchenMenu(kitchenId) {
  const cached = await storeGetOptional(menuKey(kitchenId));
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const kitchen = await requireKitchen(kitchenId);
  const [categories, dishes, combos] = await Promise.all([
    KitchenCategory.find({ kitchen: kitchenId, isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    KitchenDish.find({ kitchen: kitchenId, isActive: true, approvalStatus: "live" }).sort({ sortOrder: 1, name: 1 }).lean(),
    KitchenCombo.find({ kitchen: kitchenId, isActive: true, approvalStatus: "live" }).sort({ sortOrder: 1 }).lean(),
  ]);
  // A hidden (inactive) category hides its dishes everywhere; dishes without a category stay.
  const shown = new Set(categories.map((category) => String(category._id)));
  const visible = dishes.filter((dish) => !dish.category || shown.has(String(dish.category)));
  const menu = {
    kitchen: { kitchenId: String(kitchen._id), name: kitchen.name },
    categories: categories.map((category) => toCategory(category)),
    rawDishes: visible,
    rawCombos: combos,
  };
  await storeSet(menuKey(kitchenId), JSON.stringify(menu), MENU_TTL_SEC).catch(() => {});
  return menu;
}

// The app's Filters sheet: quick chips, sort options and their meaning.
export const QUICK_FILTERS = [
  { value: "veg", label: "Pure Veg" },
  { value: "fast", label: "Fast Delivery" },
  { value: "top_rated", label: "Top Rated" },
];
export const DISH_SORTS = [
  { value: "relevance", label: "Relevance" },
  { value: "rating", label: "Rating: High to Low" },
  { value: "prep_time", label: "Delivery Time" },
  { value: "price_asc", label: "Cost: Low to High" },
  { value: "price_desc", label: "Cost: High to Low" },
  { value: "popular", label: "Popular" },
];
const FAST_PREP_MINUTES = 15;
const TOP_RATED = 4.5;
const listParam = (value) => (Array.isArray(value) ? value : String(value || "").split(",")).map((item) => String(item).trim().toLowerCase()).filter(Boolean);

function sortDishes(list, sort) {
  const copy = [...list];
  if (sort === "price_asc") copy.sort((a, b) => a.pricePaise - b.pricePaise);
  else if (sort === "price_desc") copy.sort((a, b) => b.pricePaise - a.pricePaise);
  else if (sort === "rating") copy.sort((a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount);
  else if (sort === "prep_time") copy.sort((a, b) => (a.preparationMinutes ?? 999) - (b.preparationMinutes ?? 999));
  else if (sort === "popular") copy.sort((a, b) => Number(b.isBestseller) - Number(a.isBestseller) || (b.orderCount || 0) - (a.orderCount || 0));
  return copy;
}

/** The kitchen block on menu responses: name, open now, hours, accepting orders. */
async function kitchenState(kitchenId) {
  const [{ orderingState }, { kitchenRepository }] = await Promise.all([import("../kitchen/kitchen.hours.js"), import("../kitchen/kitchen.repository.js")]);
  const kitchen = await kitchenRepository.findActiveById(kitchenId);
  if (!kitchen) return null;
  const state = orderingState(kitchen);
  return {
    kitchenId: String(kitchen._id),
    name: kitchen.name,
    // Can orders be placed right now; when not, why (closed | paused | kitchen_unavailable) and the text to show.
    isOpenNow: Boolean(state.canOrder),
    closedReason: state.reason,
    closedMessage: state.message,
    nextOpenAt: state.opensAt ?? null,
    acceptingOrders: Boolean(kitchen.acceptingOrders),
    opensAt: kitchen.opensAt ?? null,
    closesAt: kitchen.closesAt ?? null,
  };
}

export async function customerMenu(kitchenId, { categoryId, veg, q, sort, cuisine, tag, slot, availableOnly, quick, minPricePaise, maxPricePaise } = {}) {
  const menu = await kitchenMenu(kitchenId);
  const now = new Date();
  const text = String(q || "").trim().toLowerCase();
  let dishes = menu.rawDishes.map((dish) => ({ ...toDish(dish, now), orderCount: dish.orderCount || 0 }));
  if (categoryId) dishes = dishes.filter((dish) => dish.categoryId === categoryId);
  const chips = listParam(quick);
  if (veg === true || veg === "true" || chips.includes("veg")) dishes = dishes.filter((dish) => dish.isVeg);
  if (chips.includes("fast")) dishes = dishes.filter((dish) => dish.preparationMinutes != null && dish.preparationMinutes <= FAST_PREP_MINUTES);
  if (chips.includes("top_rated")) dishes = dishes.filter((dish) => dish.rating >= TOP_RATED);
  // One or more cuisines (comma-separated): a dish matches any of them.
  const cuisines = listParam(cuisine);
  if (cuisines.length) dishes = dishes.filter((dish) => cuisines.includes(String(dish.cuisine || "").toLowerCase()));
  if (tag) dishes = dishes.filter((dish) => dish.tags.includes(String(tag).toLowerCase()));
  if (slot) dishes = dishes.filter((dish) => !dish.availableSlots.length || dish.availableSlots.includes(slot));
  if (availableOnly === true || availableOnly === "true") dishes = dishes.filter((dish) => dish.isAvailable);
  if (minPricePaise != null && minPricePaise !== "") dishes = dishes.filter((dish) => dish.pricePaise >= Number(minPricePaise));
  if (maxPricePaise != null && maxPricePaise !== "") dishes = dishes.filter((dish) => dish.pricePaise <= Number(maxPricePaise));
  if (text) dishes = dishes.filter((dish) => dish.name.toLowerCase().includes(text) || dish.tags.some((t) => t.includes(text)) || (dish.cuisine || "").toLowerCase().includes(text));
  dishes = sortDishes(dishes, sort).map(({ orderCount, ...dish }) => dish);
  const byCategory = menu.categories.map((category) => ({ ...category, dishes: dishes.filter((dish) => dish.categoryId === category.categoryId) }))
    .filter((category) => category.dishes.length);
  const uncategorised = dishes.filter((dish) => !dish.categoryId);
  if (uncategorised.length) byCategory.push({ categoryId: null, name: "More", icon: null, subtitle: null, imageUrl: null, sortOrder: 999, isActive: true, dishes: uncategorised });
  // `dishes` = the same dishes as one list in the requested sort order (for /dishes).
  return { kitchen: (await kitchenState(kitchenId)) || menu.kitchen, categories: byCategory, dishes, total: dishes.length };
}

export async function customerCategories(kitchenId) {
  const menu = await kitchenMenu(kitchenId);
  const counts = new Map();
  for (const dish of menu.rawDishes) counts.set(String(dish.category), (counts.get(String(dish.category)) || 0) + 1);
  return menu.categories.map((category) => ({ ...category, dishCount: counts.get(category.categoryId) || 0 })).filter((category) => category.dishCount > 0);
}

export async function customerDish(kitchenId, dishId, { userId = null } = {}) {
  const menu = await kitchenMenu(kitchenId);
  const dish = menu.rawDishes.find((item) => String(item._id) === String(dishId));
  if (!dish) throw new AppError(404, "Dish not found");
  const view = toDish(dish);
  if (userId) {
    const { Favorite } = await import("../favorites/favorites.model.js");
    view.isFavorite = Boolean(await Favorite.exists({ user: userId, dish: dish._id }));
  }
  view.kitchen = await kitchenState(kitchenId);
  // “From the chef” card: the dish story signed by the kitchen's chef.
  const { kitchenRepository } = await import("../kitchen/kitchen.repository.js");
  const about = (await kitchenRepository.findActiveById(kitchenId))?.about || {};
  view.chef = { name: about.chefName || null, imageUrl: about.imageUrl || null, note: view.story || null };
  return view;
}

/** Adds isFavorite to each dish for this user (one query for the whole list). */
export async function markFavorites(userId, dishes) {
  if (!userId || !dishes?.length) return dishes;
  const { Favorite } = await import("../favorites/favorites.model.js");
  const ids = dishes.map((dish) => dish.dishId);
  const liked = new Set((await Favorite.find({ user: userId, dish: { $in: ids } }).select("dish").lean()).map((row) => String(row.dish)));
  return dishes.map((dish) => ({ ...dish, isFavorite: liked.has(dish.dishId) }));
}

export async function recommendations(kitchenId, dishId, limit = 6) {
  const menu = await kitchenMenu(kitchenId);
  const dish = menu.rawDishes.find((item) => String(item._id) === String(dishId));
  if (!dish) throw new AppError(404, "Dish not found");
  const pool = menu.rawDishes.filter((item) => String(item._id) !== String(dishId) && isOrderable(item));
  const score = (item) => (dish && String(item.category) !== String(dish.category) ? 2 : 0)
    + (dish && item.isVeg === dish.isVeg ? 1 : 0)
    + (item.isBestseller ? 1 : 0)
    + Math.min(2, (item.orderCount || 0) / 50);
  return pool.sort((a, b) => score(b) - score(a)).slice(0, limit).map((item) => toDish(item));
}

export async function popularDishes(kitchenId, limit = 10) {
  const menu = await kitchenMenu(kitchenId);
  return menu.rawDishes.filter((item) => isOrderable(item))
    .sort((a, b) => Number(b.isBestseller) - Number(a.isBestseller) || (b.orderCount || 0) - (a.orderCount || 0) || (b.ratingAvg || 0) - (a.ratingAvg || 0))
    .slice(0, limit)
    .map((item) => toDish(item));
}

// Combos screen chips: All / For one / For two / Family / Under ₹500.
export const COMBO_CHIPS = [
  { value: "all", label: "All" },
  { value: "one", label: "For one" },
  { value: "two", label: "For two" },
  { value: "family", label: "Family" },
  { value: "under_500", label: "Under ₹500" },
];
const audienceOf = (serves) => (serves >= 3 ? "family" : serves === 2 ? "two" : "one");

export async function customerCombos(kitchenId, { signature = false, veg = false, chip = null } = {}) {
  const menu = await kitchenMenu(kitchenId);
  const dishes = new Map(menu.rawDishes.map((dish) => [String(dish._id), dish]));
  return menu.rawCombos.filter((combo) => !signature || combo.isSignature)
    .map((combo) => {
      const view = toCustomerCombo(combo, dishes);
      return { ...view, audience: audienceOf(view.servesCount) };
    })
    // A combo with a dish that is no longer on the menu is left out.
    .filter((combo) => combo.items.every((item) => item.name))
    .filter((combo) => !(veg === true || veg === "true") || combo.isVeg)
    .filter((combo) => !chip || chip === "all" || (chip === "under_500" ? combo.pricePaise < 50000 : combo.audience === chip));
}

export async function customerCombo(kitchenId, comboId) {
  const combo = (await customerCombos(kitchenId)).find((item) => item.comboId === String(comboId));
  if (!combo) throw new AppError(404, "Combo not found");
  return combo;
}

export async function dishFilters(kitchenId) {
  const menu = await kitchenMenu(kitchenId);
  const cuisines = [...new Set(menu.rawDishes.map((dish) => dish.cuisine).filter(Boolean))].sort();
  const tags = [...new Set(menu.rawDishes.flatMap((dish) => dish.tags || []))].sort();
  const prices = menu.rawDishes.map((dish) => dish.pricePaise);
  return {
    quick: QUICK_FILTERS,
    sort: DISH_SORTS,
    cuisines,
    tags,
    categories: menu.categories.map((category) => ({ categoryId: category.categoryId, name: category.name })),
    priceRangePaise: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
  };
}

/** Atomically reserves daily stock for ordered dishes; returns false if any ran out. */
export async function reserveStock(lines, { session = null, at = new Date() } = {}) {
  const today = istDateKey(at);
  const reserved = [];
  for (const line of lines) {
    const dish = await KitchenDish.findById(line.dishId).select("dailyStockLimit stock").session(session || null).lean();
    if (!dish?.dailyStockLimit) continue;
    if (dish.stock?.date !== today) {
      await KitchenDish.updateOne({ _id: line.dishId, "stock.date": { $ne: today } }, { $set: { stock: { date: today, sold: 0 } } }, { session: session || undefined });
    }
    const result = await KitchenDish.updateOne(
      { _id: line.dishId, "stock.date": today, "stock.sold": { $lte: dish.dailyStockLimit - line.qty } },
      { $inc: { "stock.sold": line.qty } },
      { session: session || undefined },
    );
    if (!result.modifiedCount) {
      // Release what was reserved so far.
      for (const done of reserved) await KitchenDish.updateOne({ _id: done.dishId, "stock.date": today }, { $inc: { "stock.sold": -done.qty } }, { session: session || undefined });
      return false;
    }
    reserved.push(line);
  }
  return true;
}

export async function releaseStock(lines, { at = new Date() } = {}) {
  const today = istDateKey(at);
  for (const line of lines) {
    await KitchenDish.updateOne({ _id: line.dishId, dailyStockLimit: { $gt: 0 }, "stock.date": today, "stock.sold": { $gte: line.qty } }, { $inc: { "stock.sold": -line.qty } });
  }
}

export function isValidId(value) {
  return mongoose.isValidObjectId(value);
}
