import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { addIstDays, istDateKey, istDateTime } from "../../common/time.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { acquireLock, releaseLock } from "../../infrastructure/redisStore.js";
import { publish } from "../../realtime/hub.js";
import { KitchenCategory, KitchenDish } from "../catalog/catalog.model.js";
import { currentSubscription, toSubscription } from "./subscription.service.js";
import { MealSelection, MealSlot, SLOT_KEYS, Subscription } from "./subscription.model.js";
import { cutoffAt, nextServiceDay, servesOn, validateSelection, weekdayOf } from "./subscription.rules.js";
import { menuFor, toSlot } from "./slot.service.js";

// ------------------------------------------------------------------ wording

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MEAL_STATUS_LABELS = { open: "Choose your meal", selected: "Confirmed", locked: "Being prepared", out_for_delivery: "Out for delivery", delivered: "Delivered", shifted: "Shifted", skipped: "Skipped" };

/** “12:30” → “12:30 PM” */
export function timeText(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const addMinutes = (hhmm, minutes) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
const keyParts = (dateKey) => {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return { year, month, day };
};
/** “Mon, 28 Sep 2026” */
export function dayLabel(dateKey) {
  if (!dateKey) return null;
  const d = keyParts(dateKey);
  return `${WEEKDAYS[weekdayOf(dateKey)]}, ${String(d.day).padStart(2, "0")} ${MONTHS[d.month - 1]} ${d.year}`;
}
/** “28 Sep 2026” */
const shortDate = (dateKey) => (dateKey ? dayLabel(dateKey).slice(5) : null);
const whichDay = (dateKey) => (dateKey === istDateKey() ? "Today's" : dateKey === addIstDays(istDateKey(), 1) ? "Tomorrow's" : "your");

function slotWording(slot, dateKey) {
  if (!slot) return {};
  const cutoffTime = timeText(slot.cutoffTime);
  return {
    timeLabel: `${timeText(slot.windowStart)} – ${timeText(slot.windowEnd)}`,
    cutoffLabel: slot.cutoffDay === "previous_day" ? `Until ${cutoffTime}, the day before` : `Until ${cutoffTime}`,
    prepareTitle: `Prepare ${whichDay(dateKey)} ${slot.name}`,
  };
}

/** “What's Next?” on Meal confirmed: kitchen times, or the real ones once they happen. */
function mealSteps(meal, slot) {
  if (!slot) return [];
  const at = (status) => meal.timeline?.find((entry) => entry.status === status)?.at || null;
  const real = (date) => (date ? timeText(new Date(new Date(date).getTime() + 330 * 60_000).toISOString().slice(11, 16)) : null);
  const done = { prepared: ["locked", "out_for_delivery", "delivered"], out: ["out_for_delivery", "delivered"], delivered: ["delivered"] };
  return [
    { key: "preparing", label: "Meal is being prepared", timeLabel: timeText(slot.prepStart), done: done.prepared.includes(meal.status) },
    { key: "out_for_delivery", label: "Out for delivery", timeLabel: real(at("out_for_delivery")) || timeText(slot.dispatchTime), done: done.out.includes(meal.status) },
    { key: "delivered", label: "Delivered", timeLabel: real(meal.deliveredAt) || timeText(addMinutes(slot.dispatchTime, 30) > slot.windowEnd ? slot.windowEnd : addMinutes(slot.dispatchTime, 30)), done: done.delivered.includes(meal.status) },
  ];
}

function toMeal(meal, slot, dishes = new Map()) {
  const items = (meal.items || []).map((item) => {
    const dish = dishes.get(String(item.dish));
    return { dishId: String(item.dish), name: item.name, qty: item.qty || 1, isVeg: item.isVeg !== false, imageUrl: dish?.images?.[0] || null, description: dish?.description || null };
  });
  const count = items.reduce((sum, item) => sum + item.qty, 0);
  const slotName = slot?.name || meal.slot;
  return {
    mealId: meal?._id ? String(meal._id) : null,
    date: meal.date,
    dateLabel: dayLabel(meal.date),
    slot: meal.slot,
    slotName,
    window: slot ? { start: slot.windowStart, end: slot.windowEnd } : null,
    ...slotWording(slot, meal.date),
    status: meal.status,
    statusLabel: MEAL_STATUS_LABELS[meal.status] || meal.status,
    source: meal.source || null,
    items,
    itemsLabel: `${count} ${count === 1 ? "item" : "items"}`,
    cutoffAt: meal.cutoffAt,
    editable: ["open", "selected"].includes(meal.status) && new Date(meal.cutoffAt) > new Date(),
    // Meal confirmed screen.
    confirmedTitle: `Your ${slotName} Meal is Confirmed!`,
    prepStartsLabel: slot?.prepStart ? `Preparation starts at ${timeText(slot.prepStart)}` : null,
    steps: mealSteps(meal, slot),
    shiftedTo: meal.shiftedTo || null,
    shiftedToLabel: dayLabel(meal.shiftedTo),
    shiftedFrom: meal.shiftedFrom || null,
    shiftedFromLabel: dayLabel(meal.shiftedFrom),
  };
}

/** Dish pictures for the chosen items of some meals (one query). */
async function dishesOf(meals) {
  const ids = [...new Set(meals.flatMap((meal) => (meal.items || []).map((item) => String(item.dish))))];
  if (!ids.length) return new Map();
  const rows = await KitchenDish.find({ _id: { $in: ids } }).select("images description").lean();
  return new Map(rows.map((row) => [String(row._id), row]));
}

// ------------------------------------------------------------------ which meals exist

/** Slots that apply to a subscription: the plan's slots that the kitchen runs. */
async function slotsFor(sub) {
  const slots = await MealSlot.find({ kitchen: sub.kitchen, isActive: true, key: { $in: sub.planSnapshot.slots } }).lean();
  return slots.sort((a, b) => SLOT_KEYS.indexOf(a.key) - SLOT_KEYS.indexOf(b.key));
}

/**
 * A day outside the current paid period (after it: extra days for shifted
 * meals; before it: an earlier period's extra days). Such a day only holds the
 * meals shifted there.
 */
export function isExtensionDay(sub, dateKey) {
  return (Boolean(sub.currentPeriodEnd) && dateKey > sub.currentPeriodEnd) || (Boolean(sub.currentPeriodStart) && dateKey < sub.currentPeriodStart);
}

/** The days a slot's meals can be served on: the plan's days that the kitchen runs the slot. */
function serviceDaysFor(sub, slot) {
  const planDays = sub.planSnapshot?.activeDays?.length ? sub.planSnapshot.activeDays : [0, 1, 2, 3, 4, 5, 6];
  const slotDays = slot?.activeDays?.length ? slot.activeDays : [0, 1, 2, 3, 4, 5, 6];
  const both = planDays.filter((day) => slotDays.includes(day));
  return both.length ? both : planDays;
}

/** The slot menu's dishes this plan may choose from (its categories, if it has any). */
export function allowedDishes(sub, dishes) {
  const categories = (sub.planSnapshot?.categoryIds || []).map(String);
  return categories.length ? dishes.filter((dish) => categories.includes(String(dish.categoryId))) : dishes;
}

/**
 * Whether a slot has a meal on a date: a plan day inside the paid period, or
 * an extra day that a meal of this slot was shifted to.
 */
export function slotServes(sub, slot, dateKey, stored = null) {
  if (!servesOn(sub, dateKey)) return false;
  if (!(slot.activeDays || []).includes(weekdayOf(dateKey))) return false;
  return !isExtensionDay(sub, dateKey) || Boolean(stored?.shiftedFrom);
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
  if (!sub) throw new AppError(404, "You don't have an active Meal Ji Plus subscription");
  return sub;
}

/** A slot of the plan and its stored meal row, checked to have a meal on the date. */
async function servedSlot(sub, slot, dateKey) {
  const slotDoc = await MealSlot.findOne({ kitchen: sub.kitchen, key: slot, isActive: true }).lean();
  if (!slotDoc || !sub.planSnapshot.slots.includes(slot)) throw new AppError(404, "This meal is not part of your plan");
  const stored = await MealSelection.findOne({ subscription: sub._id, date: dateKey, slot }).lean();
  if (!slotServes(sub, slotDoc, dateKey, stored) && !stored) throw new AppError(409, "No meal is due on this date");
  return { slotDoc, stored };
}

/**
 * The days' meals: stored rows, plus rows created (one batch insert) for meals
 * that are due and not stored yet. Returns one entry per date.
 */
async function buildDays(sub, slots, dates) {
  const key = (date, slot) => `${date}:${slot}`;
  let stored = await MealSelection.find({ subscription: sub._id, date: { $in: dates } }).lean();
  const have = new Set(stored.map((meal) => key(meal.date, meal.slot)));
  const now = new Date();
  // Only meals that can still be chosen get a row here; past ones are handled by the cutoff job.
  const missing = dates.flatMap((date) => slots.filter((slot) => !have.has(key(date, slot.key)) && slotServes(sub, slot, date) && cutoffAt(slot, date) > now).map((slot) => ({ subscription: sub._id, user: sub.user, kitchen: sub.kitchen, date, slot: slot.key, cutoffAt: cutoffAt(slot, date), address: sub.address, timeline: [{ status: "open", at: new Date() }] })));
  if (missing.length) {
    // A parallel request may have created some of them: duplicates are skipped.
    await MealSelection.insertMany(missing, { ordered: false }).catch((err) => {
      if (!(err?.code === 11000 || err?.writeErrors?.every((item) => item.code === 11000 || item.err?.code === 11000))) throw err;
    });
    stored = await MealSelection.find({ subscription: sub._id, date: { $in: dates } }).lean();
  }
  const byKey = new Map(stored.map((meal) => [key(meal.date, meal.slot), meal]));
  const bySlot = new Map(slots.map((slot) => [slot.key, slot]));
  const perDay = dates.map((date) => {
    const meals = [];
    for (const slot of slots) {
      const meal = byKey.get(key(date, slot.key)) || null;
      if (!meal) continue;
      if (slotServes(sub, slot, date, meal) || ["shifted", "delivered", "skipped"].includes(meal.status)) meals.push(meal);
    }
    return { date, meals };
  });
  const dishes = await dishesOf(perDay.flatMap((day) => day.meals));
  return perDay.map(({ date, meals }) => ({ date, dateLabel: dayLabel(date), servesToday: servesOn(sub, date) && (!isExtensionDay(sub, date) || meals.length > 0), meals: meals.map((meal) => toMeal(meal, bySlot.get(meal.slot), dishes)) }));
}

/** GET /subscriptions/me/days/:date – every slot of the day with its state. */
export async function dayView(userId, dateKey) {
  const sub = await requireSub(userId);
  const [day] = await buildDays(sub, await slotsFor(sub), [dateKey]);
  return { ...day, subscription: toSubscription(sub) };
}

/** Upcoming days (today + 6) for the "My meals" overview. */
export async function weekView(userId) {
  const sub = await requireSub(userId);
  const today = istDateKey();
  return buildDays(sub, await slotsFor(sub), Array.from({ length: 7 }, (_, offset) => addIstDays(today, offset)));
}

// ------------------------------------------------------------------ choosing

/** GET /subscriptions/me/menu?date&slot[&q][&categoryId] – what can be chosen for one meal. */
export async function slotMenu(userId, { date, slot, q = null, categoryId = null }) {
  const sub = await requireSub(userId);
  const slotDoc = await MealSlot.findOne({ kitchen: sub.kitchen, key: slot, isActive: true }).lean();
  if (!slotDoc || !sub.planSnapshot.slots.includes(slot)) throw new AppError(404, "This meal is not part of your plan");
  const menu = await menuFor(sub.kitchen, slot, date);
  const all = allowedDishes(sub, menu.dishes);
  // Category tabs: the categories of today's dishes, in the kitchen's order.
  const counts = new Map();
  for (const dish of all) if (dish.categoryId) counts.set(dish.categoryId, (counts.get(dish.categoryId) || 0) + 1);
  const categories = (await KitchenCategory.find({ _id: { $in: [...counts.keys()] } }).sort({ sortOrder: 1, name: 1 }).lean())
    .map((category) => ({ categoryId: String(category._id), name: category.name, imageUrl: category.imageUrl ?? null, count: counts.get(String(category._id)) }));
  const word = q ? String(q).trim().toLowerCase() : "";
  const dishes = all.filter((dish) => (!categoryId || dish.categoryId === categoryId) && (!word || dish.name.toLowerCase().includes(word) || (dish.description || "").toLowerCase().includes(word)));
  const wording = slotWording(slotDoc, date);
  return {
    date,
    dateLabel: dayLabel(date),
    slot: toSlot(slotDoc),
    title: wording.prepareTitle,
    timeLabel: wording.timeLabel,
    cutoffAt: cutoffAt(slotDoc, date),
    cutoffLabel: wording.cutoffLabel,
    maxItems: sub.planSnapshot.maxItemsPerMeal,
    minItems: sub.planSnapshot.minItemsPerMeal || 1,
    limitLabel: `You can add up to ${sub.planSnapshot.maxItemsPerMeal} ${sub.planSnapshot.maxItemsPerMeal === 1 ? "item" : "items"}`,
    categories,
    // Included in the plan: no prices on this screen.
    dishes: dishes.map((dish) => ({ ...dish, pricePaise: undefined, originalPricePaise: undefined, priceLabel: undefined })),
    defaultDishIds: menu.defaultDishIds,
    note: menu.note,
  };
}

/** PUT …/days/:date/slots/:slot/selection – before the cutoff only. */
export async function saveSelection(userId, { date, slot, items }) {
  const sub = await requireSub(userId);
  const { slotDoc, stored } = await servedSlot(sub, slot, date);
  if (!slotServes(sub, slotDoc, date, stored)) throw new AppError(409, "No meal is due on this date");
  if (cutoffAt(slotDoc, date) <= new Date()) throw new AppError(409, "The cutoff for this meal has passed");
  const menu = await menuFor(sub.kitchen, slot, date);
  const problem = validateSelection(items, { plan: sub.planSnapshot, menuDishIds: allowedDishes(sub, menu.dishes).map((dish) => dish.dishId) });
  if (problem) throw new AppError(422, problem);
  if (slotDoc.capacity > 0) {
    const taken = await MealSelection.countDocuments({ kitchen: sub.kitchen, date, slot, status: { $in: ["selected", "locked"] }, subscription: { $ne: sub._id } });
    if (taken >= slotDoc.capacity) throw new AppError(409, "This meal is fully booked for the day");
  }
  const dishes = await KitchenDish.find({ _id: { $in: items.map((item) => objectId(item.dishId, "dish ID")) } }).select("name isVeg images description").lean();
  const byId = new Map(dishes.map((dish) => [String(dish._id), dish]));
  const meal = await ensureMeal(sub, slotDoc, date);
  const first = meal.status === "open";
  const chosen = items.map((item) => ({ dish: item.dishId, name: byId.get(String(item.dishId))?.name, qty: item.qty || 1, isVeg: byId.get(String(item.dishId))?.isVeg !== false }));
  // Only an open or chosen meal before the cutoff changes (a shift or the cutoff job may have just moved it).
  const updated = await MealSelection.findOneAndUpdate(
    { _id: meal._id, status: { $in: ["open", "selected"] } },
    { $set: { items: chosen, status: "selected", source: "customer" }, $push: { timeline: { status: first ? "selected" : "modified", at: new Date() } } },
    { new: true },
  ).lean();
  if (!updated) throw new AppError(409, "This meal can no longer be changed");
  await publishEventSafe("meal.selected", { mealId: String(updated._id), userId: String(sub.user), subscriptionId: String(sub._id), kitchenId: String(sub.kitchen), date, slot, items: chosen.length, modified: !first });
  return toMeal(updated, slotDoc, byId);
}

export async function getSelection(userId, { date, slot }) {
  const sub = await requireSub(userId);
  const { slotDoc, stored } = await servedSlot(sub, slot, date);
  const meal = stored || (await ensureMeal(sub, slotDoc, date)).toObject();
  return toMeal(meal, slotDoc, await dishesOf([meal]));
}

/** The meal of a date and slot on the customer's plan (stored rows only: a tracked meal always has one). */
async function myMeal(userId, { date, slot }) {
  const sub = await requireSub(userId);
  const meal = await MealSelection.findOne({ subscription: sub._id, date, slot }).lean();
  if (!meal) throw new AppError(404, "Meal not found");
  return meal;
}

/** Meal on its way: same shape as order tracking (kitchen, destination, rider card, live position, ETA, code, "Call rider"). */
export async function mealTracking(userId, params) {
  const meal = await myMeal(userId, params);
  const { DeliveryJob } = await import("../delivery/delivery.model.js");
  const { riderCallable } = await import("../delivery/delivery.service.js");
  const { riderCard, trackingFields } = await import("../delivery/rider.view.js");
  const { Kitchen } = await import("../kitchen/kitchen.model.js");
  const [job, slot, kitchen] = await Promise.all([
    meal.deliveryJob ? DeliveryJob.findById(meal.deliveryJob).lean() : null,
    MealSlot.findOne({ kitchen: meal.kitchen, key: meal.slot }).lean(),
    Kitchen.findById(meal.kitchen).select("name latitude longitude").lean(),
  ]);
  const active = ["selected", "locked", "out_for_delivery"].includes(meal.status);
  return {
    mealId: String(meal._id),
    status: meal.status,
    statusLabel: MEAL_STATUS_LABELS[meal.status] || meal.status,
    kitchen: kitchen ? { name: kitchen.name, latitude: kitchen.latitude, longitude: kitchen.longitude } : null,
    destination: meal.address ? { latitude: meal.address.latitude, longitude: meal.address.longitude, fullAddress: meal.address.fullAddress } : null,
    rider: riderCard(job?.rider, { onTheWay: meal.status === "out_for_delivery" }),
    ...trackingFields(job, { fallbackEta: slot?.windowEnd ? istDateTime(meal.date, slot.windowEnd) : null, active, canCallRider: riderCallable(job) }),
  };
}

export async function callMealRider(userId, params) {
  const meal = await myMeal(userId, params);
  const { callRider } = await import("../delivery/delivery.service.js");
  return callRider(userId, { mealId: String(meal._id) });
}

// ------------------------------------------------------------------ shifting

/**
 * Where a shifted meal of this slot goes: the first extra day after the paid
 * period that has no meal of this slot yet (lunch and dinner of one day share
 * one extra day; a second lunch takes the next one).
 */
async function extensionDayFor(sub, slot) {
  const end = sub.currentPeriodEnd || sub.validTill;
  const days = serviceDaysFor(sub, slot);
  const taken = new Set((await MealSelection.find({ subscription: sub._id, slot: slot.key, date: { $gt: end }, shiftedFrom: { $ne: null } }).select("date").lean()).map((meal) => meal.date));
  let day = nextServiceDay(end, days);
  for (let i = 0; i < 120 && taken.has(day); i += 1) day = nextServiceDay(day, days);
  return day;
}

/**
 * Moves a meal (or every meal of a day when slot is omitted) to the end of the
 * subscription: the slot is marked shifted and its meal goes to the first free
 * extra day; validTill grows only when that day is new. One shift at a time
 * per subscription. Manual shifts count towards the plan's limit; automatic
 * ones only if the plan says so.
 */
export async function shiftMeals(sub, { date, slot = null, kind = "manual" }) {
  const lockKey = `subscription:shift:${sub._id}`;
  let token = await acquireLock(lockKey, 30);
  for (let attempt = 0; !token && kind === "auto" && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    token = await acquireLock(lockKey, 30);
  }
  if (!token) throw new AppError(409, "Your meal is already being shifted");
  try {
    // Fresh dates and counters (a shift that just finished changed them).
    const fresh = await Subscription.findById(sub._id).select("validTill currentPeriodEnd shiftsThisCycle autoShiftsThisCycle").lean();
    Object.assign(sub, { validTill: fresh.validTill, currentPeriodEnd: fresh.currentPeriodEnd, shiftsThisCycle: fresh.shiftsThisCycle, autoShiftsThisCycle: fresh.autoShiftsThisCycle });
    return await shiftLocked(sub, { date, slot, kind });
  } finally {
    await releaseLock(lockKey, token);
  }
}

async function shiftLocked(sub, { date, slot, kind }) {
  const slots = (await slotsFor(sub)).filter((item) => !slot || item.key === slot);
  if (!slots.length) throw new AppError(404, "No meal to shift");
  const plan = sub.planSnapshot;
  const counts = kind === "manual" || plan.autoShiftCountsTowardLimit;
  if (kind === "manual" && plan.maxShiftsPerCycle > 0 && (sub.shiftsThisCycle || 0) >= plan.maxShiftsPerCycle) {
    throw new AppError(409, `You can shift up to ${plan.maxShiftsPerCycle} meal day(s) per cycle`);
  }
  const previousValidTill = sub.validTill;
  const shifted = [];
  for (const slotDoc of slots) {
    const stored = await MealSelection.findOne({ subscription: sub._id, date, slot: slotDoc.key }).lean();
    if (!slotServes(sub, slotDoc, date, stored)) continue;
    const meal = await ensureMeal(sub, slotDoc, date);
    // A meal with a rider booked is on its way: it can no longer be shifted.
    if (kind === "manual" && (cutoffAt(slotDoc, date) <= new Date() || !["open", "selected"].includes(meal.status) || meal.deliveryJob)) continue;
    if (meal.status === "shifted") continue;
    const newDay = await extensionDayFor(sub, slotDoc);
    // The cutoff job only moves a meal nobody chose (a choice saved at the last second stays).
    const moved = await MealSelection.findOneAndUpdate(
      { _id: meal._id, status: { $in: kind === "auto" ? ["open"] : ["open", "selected"] }, deliveryJob: null },
      { $set: { status: "shifted", shiftedTo: newDay, shiftKind: kind }, $push: { timeline: { status: "shifted", at: new Date() } } },
      { new: true },
    );
    if (!moved) continue;
    const target = await ensureMeal(sub, slotDoc, newDay);
    target.shiftedFrom = date;
    await target.save();
    shifted.push({ slot: slotDoc.key, slotName: slotDoc.name, shiftedTo: newDay });
  }
  if (!shifted.length) throw new AppError(409, "These meals can no longer be shifted");
  const lastDay = shifted.map((item) => item.shiftedTo).sort().at(-1);
  if (!sub.validTill || lastDay > sub.validTill) sub.validTill = lastDay;
  if (counts) sub.shiftsThisCycle = (sub.shiftsThisCycle || 0) + 1;
  if (kind === "auto") sub.autoShiftsThisCycle = (sub.autoShiftsThisCycle || 0) + 1;
  const entry = { at: new Date(), event: kind === "auto" ? "meal_auto_shifted" : "meal_shifted", note: `${date} → ${lastDay}`, by: kind === "auto" ? "system" : "customer" };
  if (Array.isArray(sub.history)) sub.history.push(entry);
  // The next bill comes after the extra days, so the next paid period never overlaps them.
  const fresh = await Subscription.findById(sub._id).select("nextBillingDate").lean();
  const nextBilling = fresh?.nextBillingDate && fresh.nextBillingDate <= sub.validTill ? addIstDays(sub.validTill, 1) : null;
  if (nextBilling) sub.nextBillingDate = nextBilling;
  await Subscription.updateOne({ _id: sub._id }, { $set: { validTill: sub.validTill, shiftsThisCycle: sub.shiftsThisCycle || 0, autoShiftsThisCycle: sub.autoShiftsThisCycle || 0, ...(nextBilling ? { nextBillingDate: nextBilling } : {}) }, $push: { history: entry } });
  if (sub.validTill !== previousValidTill) {
    const { User } = await import("../user/user.model.js");
    const { istDateTime } = await import("../../common/time.js");
    await User.updateOne({ _id: sub.user }, { $set: { "subscription.expiresAt": istDateTime(sub.validTill, "23:59") } });
  }
  await publishEventSafe("meal.shifted", { subscriptionId: String(sub._id), userId: String(sub.user), kitchenId: String(sub.kitchen), date, shiftedTo: lastDay, kind, slots: shifted.map((item) => item.slot), slotName: shifted.map((item) => item.slotName).join(" & ") });
  const longer = sub.validTill !== previousValidTill;
  return {
    date,
    shiftedFromLabel: shortDate(date),
    shiftedTo: lastDay,
    shiftedToLabel: dayLabel(lastDay),
    slots: shifted.map((item) => ({ ...item, shiftedToLabel: dayLabel(item.shiftedTo) })),
    validTill: sub.validTill,
    validTillLabel: dayLabel(sub.validTill),
    previousValidTill,
    previousValidTillLabel: dayLabel(previousValidTill),
    shiftsLeft: plan.maxShiftsPerCycle > 0 ? Math.max(0, plan.maxShiftsPerCycle - (sub.shiftsThisCycle || 0)) : null,
    // Meal shifted screen.
    message: `Your meal is saved for ${dayLabel(lastDay)}. ${longer ? "Your subscription now lasts one day longer." : `Your subscription still ends on ${dayLabel(sub.validTill)}.`}`,
    note: "No meal lost. The rest of your plan stays the same.",
  };
}

/** Shift meal confirm screen: what a shift would do, before it is made. */
export async function shiftPreview(userId, { date, slot = null }) {
  const sub = await requireSub(userId);
  const plan = sub.planSnapshot;
  const slots = (await slotsFor(sub)).filter((item) => !slot || item.key === slot);
  if (!slots.length) throw new AppError(404, "This meal is not part of your plan");
  const stored = new Map((await MealSelection.find({ subscription: sub._id, date }).lean()).map((meal) => [meal.slot, meal]));
  const due = slots.filter((item) => slotServes(sub, item, date, stored.get(item.key) || null));
  if (!due.length) throw new AppError(409, "No meal is due on this date");
  const movable = due.filter((item) => cutoffAt(item, date) > new Date() && ["open", "selected"].includes(stored.get(item.key)?.status || "open") && !stored.get(item.key)?.deliveryJob);
  const targets = await Promise.all(movable.map((item) => extensionDayFor(sub, item)));
  const shiftedTo = targets.sort().at(-1) || nextServiceDay(sub.currentPeriodEnd || sub.validTill, plan.activeDays);
  const newValidTill = shiftedTo > sub.validTill ? shiftedTo : sub.validTill;
  const left = plan.maxShiftsPerCycle > 0 ? Math.max(0, plan.maxShiftsPerCycle - (sub.shiftsThisCycle || 0)) : null;
  const reason = !movable.length ? "This meal can no longer be shifted" : left === 0 ? `You can shift up to ${plan.maxShiftsPerCycle} meal day(s) per cycle` : null;
  const name = slot ? due[0].name : "meals";
  const when = date === istDateKey() ? "today" : `on ${dayLabel(date)}`;
  return {
    date,
    dateLabel: dayLabel(date),
    slot,
    slotName: slot ? due[0].name : "All meals",
    timeLabel: slot ? slotWording(due[0], date).timeLabel : null,
    shiftedTo,
    shiftedToLabel: dayLabel(shiftedTo),
    currentValidTill: sub.validTill,
    currentValidTillLabel: dayLabel(sub.validTill),
    newValidTill,
    newValidTillLabel: dayLabel(newValidTill),
    shiftsLeft: left,
    allowed: !reason,
    reason,
    message: `No ${name} will be delivered ${when}. ${newValidTill > sub.validTill ? "Your plan extends by 1 day to include this meal." : "It moves to the extra day you already have."}`,
    note: "One extra day. No meal lost.",
  };
}

export async function shift(userId, input) {
  const sub = await requireSub(userId);
  return shiftMeals(sub, { ...input, kind: "manual" });
}

// ---- kitchen dispatch

export async function kitchenMealAction(kitchenId, mealId, action, { fromPartner = false } = {}) {
  const meal = await MealSelection.findOne({ _id: objectId(mealId, "meal ID"), kitchen: kitchenId });
  if (!meal) throw new AppError(404, "Meal not found");
  // A partner-run drop moves with its rider (picked up → out for delivery → delivered), not by hand.
  if (!fromPartner && meal.deliveryJob) {
    const { partnerRunsDelivery } = await import("../delivery/delivery.service.js");
    if (await partnerRunsDelivery(meal.deliveryJob)) throw new AppError(409, "This meal's delivery is run by the delivery partner");
  }
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

/**
 * "Dispatch all" for the kitchen's own riders: meals whose drop is booked with
 * a partner (or will be: the slot's meals go to a partner) are left to the rider.
 */
export async function kitchenBulkDispatch(kitchenId, { date, slot }) {
  const { mealDropProviderFor } = await import("../delivery/delivery.service.js");
  const mealDropProvider = await mealDropProviderFor(kitchenId);
  const meals = await MealSelection.find({ kitchen: kitchenId, date, slot, status: "locked" }).select("_id deliveryJob").lean();
  let dispatched = 0;
  let skipped = 0;
  for (const meal of meals) {
    if (!meal.deliveryJob && !["manual", "self"].includes(mealDropProvider)) {
      skipped += 1;
      continue;
    }
    try {
      await kitchenMealAction(kitchenId, meal._id, "dispatch");
      dispatched += 1;
    } catch (err) {
      if (err.statusCode !== 409) throw err;
      skipped += 1;
    }
  }
  return { dispatched, skippedForPartner: skipped };
}
