import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { normalizeCity } from "../settings/settings.resolver.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { NO_SELECTION_POLICIES, SLOT_KEYS, Subscription, SubscriptionPlan } from "./subscription.model.js";

export function toPlan(plan, { admin = false } = {}) {
  const view = {
    planId: String(plan._id),
    planCode: plan.code,
    name: plan.name,
    subtitle: plan.subtitle ?? null,
    badge: plan.badge ?? null,
    description: plan.description || "",
    imageUrl: plan.imageUrl ?? null,
    pricePaise: plan.pricePaise,
    mrpPaise: plan.mrpPaise ?? null,
    cycleDays: plan.cycleDays,
    cycleLabel: plan.cycleLabel,
    mealsPerDay: plan.mealsPerDay,
    slots: plan.slots,
    maxItemsPerMeal: plan.maxItemsPerMeal,
    minItemsPerMeal: plan.minItemsPerMeal,
    deliveryIncluded: plan.deliveryIncluded,
    deliveryFeePaise: plan.deliveryFeePaise || 0,
    benefits: plan.benefits || [],
    perks: plan.perks || {},
    billingMethods: plan.billingMethods,
    activeDays: plan.activeDays,
    maxShiftsPerCycle: plan.maxShiftsPerCycle,
    isPopular: Boolean(plan.isPopular),
    sortOrder: plan.sortOrder || 0,
  };
  if (!admin) return view;
  return {
    ...view,
    status: plan.status,
    kitchenIds: (plan.kitchens || []).map(String),
    cities: plan.cities || [],
    categoryIds: (plan.categoryIds || []).map(String),
    noSelectionPolicy: plan.noSelectionPolicy,
    autoShiftCountsTowardLimit: plan.autoShiftCountsTowardLimit,
    maxAutoShiftsPerCycle: plan.maxAutoShiftsPerCycle,
    autoShiftFallback: plan.autoShiftFallback,
    renewalPriceMode: plan.renewalPriceMode,
    activeFrom: plan.activeFrom,
    activeTo: plan.activeTo,
    updatedAt: plan.updatedAt,
  };
}

/** The frozen terms a subscriber keeps. */
export function planSnapshot(plan) {
  return { ...toPlan(plan, { admin: true }), snapshotAt: new Date() };
}

function planData(input, partial) {
  const errors = [];
  const out = {};
  const str = (key, max) => {
    if (input[key] !== undefined) out[key] = input[key] == null ? null : String(input[key]).trim().slice(0, max);
  };
  if (!partial || input.code !== undefined) {
    if (!/^[A-Z0-9_]{2,30}$/i.test(String(input.code || ""))) errors.push({ field: "code", message: "Code: 2-30 letters, digits or _" });
    else out.code = String(input.code).toUpperCase();
  }
  if (!partial || input.name !== undefined) {
    if (!input.name || String(input.name).trim().length > 60) errors.push({ field: "name", message: "Name is required (max 60)" });
    else out.name = String(input.name).trim();
  }
  str("subtitle", 120);
  str("badge", 30);
  str("description", 1000);
  str("cycleLabel", 30);
  if (out.cycleLabel === null || out.cycleLabel === "") out.cycleLabel = "Monthly";
  if (input.imageUrl !== undefined) out.imageUrl = assertOwnFileUrl(input.imageUrl, "Plan image");
  const int = (key, min, max, required = false) => {
    if (input[key] === undefined) {
      if (required && !partial) errors.push({ field: key, message: `${key} is required` });
      return;
    }
    if (input[key] === null && !required) {
      out[key] = null;
      return;
    }
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) errors.push({ field: key, message: `${key} must be ${min} to ${max}` });
    else out[key] = input[key];
  };
  int("pricePaise", 0, 100_000_000, true);
  int("mrpPaise", 0, 100_000_000);
  int("cycleDays", 1, 366, true);
  int("mealsPerDay", 1, 3);
  int("maxItemsPerMeal", 1, 20);
  int("minItemsPerMeal", 1, 20);
  int("deliveryFeePaise", 0, 1_000_000);
  int("maxShiftsPerCycle", 0, 60);
  int("maxAutoShiftsPerCycle", 0, 60);
  int("sortOrder", -1000, 1000);
  if (input.slots !== undefined) {
    if (!Array.isArray(input.slots) || !input.slots.length || input.slots.some((slot) => !SLOT_KEYS.includes(slot))) errors.push({ field: "slots", message: `Slots: ${SLOT_KEYS.join(", ")}` });
    else out.slots = [...new Set(input.slots)];
  }
  if (input.activeDays !== undefined) {
    if (!Array.isArray(input.activeDays) || !input.activeDays.length || input.activeDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) errors.push({ field: "activeDays", message: "Days are 0 (Sunday) to 6" });
    else out.activeDays = [...new Set(input.activeDays)].sort();
  }
  if (input.billingMethods !== undefined) {
    if (!Array.isArray(input.billingMethods) || !input.billingMethods.length || input.billingMethods.some((method) => !["autopay", "link"].includes(method))) errors.push({ field: "billingMethods", message: "Offer autopay, link or both" });
    else out.billingMethods = [...new Set(input.billingMethods)];
  }
  if (input.noSelectionPolicy !== undefined) {
    if (!NO_SELECTION_POLICIES.includes(input.noSelectionPolicy)) errors.push({ field: "noSelectionPolicy", message: NO_SELECTION_POLICIES.join(", ") });
    else out.noSelectionPolicy = input.noSelectionPolicy;
  }
  if (input.autoShiftFallback !== undefined) out.autoShiftFallback = input.autoShiftFallback === "chef_default" ? "chef_default" : "skip";
  if (input.renewalPriceMode !== undefined) out.renewalPriceMode = input.renewalPriceMode === "new_price" ? "new_price" : "keep";
  for (const key of ["deliveryIncluded", "isPopular", "autoShiftCountsTowardLimit"]) if (input[key] !== undefined) out[key] = Boolean(input[key]);
  if (input.benefits !== undefined) out.benefits = (input.benefits || []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().slice(0, 100)).slice(0, 12);
  if (input.perks !== undefined) out.perks = { freeDeliveryOnOrders: Boolean(input.perks?.freeDeliveryOnOrders), orderDiscountPercent: Math.min(50, Math.max(0, Number(input.perks?.orderDiscountPercent) || 0)) };
  if (input.kitchenIds !== undefined) out.kitchens = (input.kitchenIds || []).map((id) => objectId(id, "kitchen ID"));
  if (input.categoryIds !== undefined) out.categoryIds = (input.categoryIds || []).map((id) => objectId(id, "category ID"));
  if (input.cities !== undefined) out.cities = (input.cities || []).map(normalizeCity).filter(Boolean);
  for (const key of ["activeFrom", "activeTo"]) if (input[key] !== undefined) out[key] = input[key] ? new Date(input[key]) : null;
  if (out.minItemsPerMeal && out.maxItemsPerMeal && out.minItemsPerMeal > out.maxItemsPerMeal) errors.push({ field: "minItemsPerMeal", message: "Minimum is above maximum" });
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  return out;
}

export async function listPlans({ status } = {}) {
  const filter = status ? { status } : {};
  const plans = await SubscriptionPlan.find(filter).sort({ status: 1, sortOrder: 1, pricePaise: 1 }).lean();
  const counts = await Subscription.aggregate([{ $match: { status: { $in: ["active", "pause_scheduled", "paused", "cancel_scheduled", "past_due"] } } }, { $group: { _id: "$plan", total: { $sum: 1 } } }]);
  const byPlan = new Map(counts.map((row) => [String(row._id), row.total]));
  return plans.map((plan) => ({ ...toPlan(plan, { admin: true }), subscribers: byPlan.get(String(plan._id)) || 0 }));
}

export async function getPlan(planId) {
  const plan = await SubscriptionPlan.findById(objectId(planId, "plan ID")).lean();
  if (!plan) throw new AppError(404, "Plan not found");
  return plan;
}

export async function savePlan(planId, input) {
  const data = planData(input, Boolean(planId));
  try {
    if (!planId) return toPlan(await SubscriptionPlan.create(data), { admin: true });
    const plan = await SubscriptionPlan.findById(objectId(planId, "plan ID"));
    if (!plan) throw new AppError(404, "Plan not found");
    if (plan.status === "retired" && input.status !== "active") throw new AppError(409, "Retired plans cannot be edited. Duplicate it instead.");
    const before = toPlan(plan, { admin: true });
    Object.assign(plan, data);
    await plan.save();
    return { before, after: toPlan(plan, { admin: true }) };
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "Another plan already uses this code");
    throw err;
  }
}

/** Copies a plan (any status) into a new draft with a new code. */
export async function duplicatePlan(planId, { code, name } = {}) {
  const source = await SubscriptionPlan.findById(objectId(planId, "plan ID")).lean();
  if (!source) throw new AppError(404, "Plan not found");
  const { _id, createdAt, updatedAt, __v, ...rest } = source;
  const newCode = String(code || `${source.code}_COPY`).toUpperCase().slice(0, 30);
  try {
    return toPlan(await SubscriptionPlan.create({ ...rest, code: newCode, name: name || `${source.name} (copy)`, status: "draft" }), { admin: true });
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "Another plan already uses this code");
    throw err;
  }
}

export async function setPlanStatus(planId, status) {
  if (!["draft", "active", "retired"].includes(status)) throw new AppError(422, "Status: draft, active or retired");
  const plan = await SubscriptionPlan.findByIdAndUpdate(objectId(planId, "plan ID"), { $set: { status } }, { new: true });
  if (!plan) throw new AppError(404, "Plan not found");
  return toPlan(plan, { admin: true });
}

/** Active plans sold at a kitchen (kitchen list or city match, inside the active window). */
export async function plansForKitchen(kitchenId, { limit = 50 } = {}) {
  const kitchen = await Kitchen.findById(kitchenId).select("city").lean();
  const now = new Date();
  const plans = await SubscriptionPlan.find({
    status: "active",
    $and: [
      { $or: [{ activeFrom: null }, { activeFrom: { $lte: now } }] },
      { $or: [{ activeTo: null }, { activeTo: { $gte: now } }] },
    ],
  }).sort({ sortOrder: 1, pricePaise: 1 }).lean();
  const city = normalizeCity(kitchen?.city);
  return plans
    .filter((plan) => (!plan.kitchens?.length || plan.kitchens.map(String).includes(String(kitchenId))) && (!plan.cities?.length || plan.cities.includes(city)))
    .slice(0, limit)
    .map((plan) => toPlan(plan));
}
