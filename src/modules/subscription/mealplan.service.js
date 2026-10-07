import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { addIstDays, istDateKey } from "../../common/time.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { publish } from "../../realtime/hub.js";
import { KitchenDish } from "../catalog/catalog.model.js";
import { currentSubscription, toSubscription } from "./subscription.service.js";
import { MealSelection, MealSlot, Subscription } from "./subscription.model.js";
import { cutoffAt, nextServiceDay, servesOn, validateSelection } from "./subscription.rules.js";
import { menuFor, toSlot } from "./slot.service.js";

function toMeal(meal, slot) {
  return {
    mealId: meal?._id ? String(meal._id) : null,
    date: meal.date,
    slot: meal.slot,
    slotName: slot?.name || meal.slot,
    window: slot ? { start: slot.windowStart, end: slot.windowEnd } : null,
    status: meal.status,
    source: meal.source || null,
    items: (meal.items || []).map((item) => ({ dishId: String(item.dish), name: item.name, qty: item.qty || 1, isVeg: item.isVeg !== false })),
    cutoffAt: meal.cutoffAt,
    editable: ["open", "selected"].includes(meal.status) && new Date(meal.cutoffAt) > new Date(),
    shiftedTo: meal.shiftedTo || null,
    shiftedFrom: meal.shiftedFrom || null,
  };
}

/** Slots that apply to a subscription: the plan's slots that the kitchen runs. */
async function slotsFor(sub) {
  const slots = await MealSlot.find({ kitchen: sub.kitchen, isActive: true, key: { $in: sub.planSnapshot.slots } }).lean();
  return slots;
}

/** The meal row for a subscription/date/slot, created on first access. */
export async function ensureMeal(sub, slot, dateKey) {
  const existing = await MealSelection.findOne({ subscription: sub._id, date: dateKey, slot: slot.key });
  if (existing) return existing;
  try {
    return await MealSelection.create({ subscription: sub._id, user: sub.user, kitchen: sub.kitchen, date: dateKey, slot: slot.key, cutoffAt: cutoffAt(slot, dateKey), address: sub.address, timeline: [{ status: "open", at: new Date() }] });
  } catch (err) {
    if (err?.code === 11000) return MealSelection.findOne({ subscription: sub._id, date: dateKey, slot: slot.key });
    throw err;
  }
}

async function requireSub(userId) {
  const sub = await currentSubscription(userId);
  if (!sub) throw new AppError(404, "You don't have an active MealJi Plus subscription");
  return sub;
}

/** GET /subscriptions/me/days/:date – every slot of the day with its state. */
export async function dayView(userId, dateKey) {
  const sub = await requireSub(userId);
  const slots = await slotsFor(sub);
  const serves = servesOn(sub, dateKey);
  const meals = [];
  for (const slot of slots) {
    if (!(slot.activeDays || []).includes(new Date(`${dateKey}T12:00:00+05:30`).getUTCDay())) continue;
    const stored = await MealSelection.findOne({ subscription: sub._id, date: dateKey, slot: slot.key }).lean();
    if (!stored && !serves) continue;
    const meal = stored || (await ensureMeal(sub, slot, dateKey)).toObject();
    meals.push(toMeal(meal, slot));
  }
  return { date: dateKey, servesToday: serves, subscription: toSubscription(sub), meals };
}

/** GET /subscriptions/me/menu?date&slot – what can be chosen for one meal. */
export async function slotMenu(userId, { date, slot }) {
  const sub = await requireSub(userId);
  const slotDoc = await MealSlot.findOne({ kitchen: sub.kitchen, key: slot, isActive: true }).lean();
  if (!slotDoc || !sub.planSnapshot.slots.includes(slot)) throw new AppError(404, "This meal is not part of your plan");
  const menu = await menuFor(sub.kitchen, slot, date);
  const allowedCategories = (sub.planSnapshot.categoryIds || []).map(String);
  const dishes = allowedCategories.length ? menu.dishes.filter((dish) => allowedCategories.includes(dish.categoryId)) : menu.dishes;
  return {
    date,
    slot: toSlot(slotDoc),
    cutoffAt: cutoffAt(slotDoc, date),
    maxItems: sub.planSnapshot.maxItemsPerMeal,
    minItems: sub.planSnapshot.minItemsPerMeal || 1,
    dishes: dishes.map((dish) => ({ ...dish, pricePaise: undefined, originalPricePaise: undefined })),
    defaultDishIds: menu.defaultDishIds,
    note: menu.note,
  };
}

/** PUT …/days/:date/slots/:slot/selection – before the cutoff only. */
export async function saveSelection(userId, { date, slot, items }) {
  const sub = await requireSub(userId);
  if (!servesOn(sub, date)) throw new AppError(409, "No meal is due on this date");
  const slotDoc = await MealSlot.findOne({ kitchen: sub.kitchen, key: slot, isActive: true }).lean();
  if (!slotDoc || !sub.planSnapshot.slots.includes(slot)) throw new AppError(404, "This meal is not part of your plan");
  if (cutoffAt(slotDoc, date) <= new Date()) throw new AppError(409, "The cutoff for this meal has passed");
  const menu = await menuFor(sub.kitchen, slot, date);
  const problem = validateSelection(items, { plan: sub.planSnapshot, menuDishIds: menu.dishes.map((dish) => dish.dishId) });
  if (problem) throw new AppError(422, problem);
  if (slotDoc.capacity > 0) {
    const taken = await MealSelection.countDocuments({ kitchen: sub.kitchen, date, slot, status: { $in: ["selected", "locked"] }, subscription: { $ne: sub._id } });
    if (taken >= slotDoc.capacity) throw new AppError(409, "This meal is fully booked for the day");
  }
  const dishes = await KitchenDish.find({ _id: { $in: items.map((item) => objectId(item.dishId, "dish ID")) } }).select("name isVeg").lean();
  const byId = new Map(dishes.map((dish) => [String(dish._id), dish]));
  const meal = await ensureMeal(sub, slotDoc, date);
  if (!["open", "selected"].includes(meal.status)) throw new AppError(409, "This meal can no longer be changed");
  meal.items = items.map((item) => ({ dish: item.dishId, name: byId.get(String(item.dishId))?.name, qty: item.qty || 1, isVeg: byId.get(String(item.dishId))?.isVeg !== false }));
  const first = meal.status === "open";
  meal.status = "selected";
  meal.source = "customer";
  meal.timeline.push({ status: first ? "selected" : "modified", at: new Date() });
  await meal.save();
  await publishEventSafe("meal.selected", { mealId: String(meal._id), userId: String(sub.user), subscriptionId: String(sub._id), kitchenId: String(sub.kitchen), date, slot, items: meal.items.length, modified: !first });
  return toMeal(meal.toObject(), slotDoc);
}

export async function getSelection(userId, { date, slot }) {
  const sub = await requireSub(userId);
  const slotDoc = await MealSlot.findOne({ kitchen: sub.kitchen, key: slot }).lean();
  const meal = await MealSelection.findOne({ subscription: sub._id, date, slot }).lean();
  if (!meal) {
    if (!slotDoc || !servesOn(sub, date)) throw new AppError(404, "No meal on this date");
    return toMeal((await ensureMeal(sub, slotDoc, date)).toObject(), slotDoc);
  }
  return toMeal(meal, slotDoc);
}

/**
 * Moves a meal (or every meal of a day when slot is omitted) to the end of the
 * subscription: the slot is marked shifted, validTill grows by one day and a
 * meal row is opened on the new last day. Manual shifts count towards the
 * plan's limit; automatic ones only if the plan says so.
 */
export async function shiftMeals(sub, { date, slot = null, kind = "manual" }) {
  const slots = (await slotsFor(sub)).filter((item) => !slot || item.key === slot);
  if (!slots.length) throw new AppError(404, "No meal to shift");
  const plan = sub.planSnapshot;
  const counts = kind === "manual" || plan.autoShiftCountsTowardLimit;
  if (kind === "manual" && plan.maxShiftsPerCycle > 0 && (sub.shiftsThisCycle || 0) >= plan.maxShiftsPerCycle) {
    throw new AppError(409, `You can shift up to ${plan.maxShiftsPerCycle} meal day(s) per cycle`);
  }
  const shifted = [];
  const newDay = nextServiceDay(sub.validTill, plan.activeDays);
  for (const slotDoc of slots) {
    const meal = await ensureMeal(sub, slotDoc, date);
    if (kind === "manual" && (cutoffAt(slotDoc, date) <= new Date() || !["open", "selected"].includes(meal.status))) continue;
    if (meal.status === "shifted") continue;
    meal.status = "shifted";
    meal.shiftedTo = newDay;
    meal.shiftKind = kind;
    meal.timeline.push({ status: "shifted", at: new Date() });
    await meal.save();
    const target = await ensureMeal(sub, slotDoc, newDay);
    target.shiftedFrom = date;
    await target.save();
    shifted.push({ slot: slotDoc.key, slotName: slotDoc.name, shiftedTo: newDay });
  }
  if (!shifted.length) throw new AppError(409, "These meals can no longer be shifted");
  sub.validTill = newDay;
  if (counts) sub.shiftsThisCycle = (sub.shiftsThisCycle || 0) + 1;
  if (kind === "auto") sub.autoShiftsThisCycle = (sub.autoShiftsThisCycle || 0) + 1;
  sub.history.push({ at: new Date(), event: kind === "auto" ? "meal_auto_shifted" : "meal_shifted", note: `${date} → ${newDay}`, by: kind === "auto" ? "system" : "customer" });
  await Subscription.updateOne({ _id: sub._id }, { $set: { validTill: sub.validTill, shiftsThisCycle: sub.shiftsThisCycle, autoShiftsThisCycle: sub.autoShiftsThisCycle }, $push: { history: sub.history[sub.history.length - 1] } });
  await publishEventSafe("meal.shifted", { subscriptionId: String(sub._id), userId: String(sub.user), kitchenId: String(sub.kitchen), date, shiftedTo: newDay, kind, slots: shifted.map((item) => item.slot), slotName: shifted.map((item) => item.slotName).join(" & ") });
  return { date, shiftedTo: newDay, slots: shifted, validTill: newDay, shiftsLeft: Math.max(0, plan.maxShiftsPerCycle - sub.shiftsThisCycle) };
}

export async function shiftPreview(userId, { date, slot = null }) {
  const sub = await requireSub(userId);
  if (!servesOn(sub, date)) throw new AppError(409, "No meal is due on this date");
  const plan = sub.planSnapshot;
  const left = plan.maxShiftsPerCycle > 0 ? Math.max(0, plan.maxShiftsPerCycle - (sub.shiftsThisCycle || 0)) : null;
  return {
    date,
    slot,
    shiftedTo: nextServiceDay(sub.validTill, plan.activeDays),
    currentValidTill: sub.validTill,
    newValidTill: nextServiceDay(sub.validTill, plan.activeDays),
    shiftsLeft: left,
    allowed: left == null || left > 0,
  };
}

export async function shift(userId, input) {
  const sub = await requireSub(userId);
  if (!servesOn(sub, input.date)) throw new AppError(409, "No meal is due on this date");
  return shiftMeals(sub, { ...input, kind: "manual" });
}

/** Upcoming days (today + 6) for the "My meals" overview. */
export async function weekView(userId) {
  const today = istDateKey();
  const days = [];
  for (let offset = 0; offset < 7; offset += 1) days.push(await dayView(userId, addIstDays(today, offset)));
  return days.map((day) => ({ date: day.date, servesToday: day.servesToday, meals: day.meals }));
}

// ---- kitchen dispatch

export async function kitchenMealAction(kitchenId, mealId, action) {
  const meal = await MealSelection.findOne({ _id: objectId(mealId, "meal ID"), kitchen: kitchenId });
  if (!meal) throw new AppError(404, "Meal not found");
  const next = { dispatch: "out_for_delivery", deliver: "delivered" }[action];
  if (!next) throw new AppError(422, "Unknown action");
  if (action === "dispatch" && !["locked", "selected"].includes(meal.status)) throw new AppError(409, "Only locked meals can be dispatched");
  if (action === "deliver" && !["out_for_delivery", "locked"].includes(meal.status)) throw new AppError(409, "Dispatch the meal first");
  meal.status = next;
  if (next === "delivered") meal.deliveredAt = new Date();
  meal.timeline.push({ status: next, at: new Date() });
  await meal.save();
  await publishEventSafe(next === "delivered" ? "meal.delivered" : "meal.out_for_delivery", { mealId: String(meal._id), userId: String(meal.user), kitchenId: String(kitchenId), date: meal.date, slot: meal.slot });
  publish(`user:${meal.user}`, "meal:status", { mealId: String(meal._id), date: meal.date, slot: meal.slot, status: next });
  return { mealId: String(meal._id), status: meal.status };
}

export async function kitchenBulkDispatch(kitchenId, { date, slot }) {
  const meals = await MealSelection.find({ kitchen: kitchenId, date, slot, status: "locked" }).select("_id").lean();
  for (const meal of meals) await kitchenMealAction(kitchenId, meal._id, "dispatch");
  return { dispatched: meals.length };
}
