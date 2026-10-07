import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { PdfDocument } from "../../common/pdf.js";
import { addIstDays, istDateKey } from "../../common/time.js";
import { KitchenDish } from "../catalog/catalog.model.js";
import { toDish } from "../catalog/catalog.service.js";
import { MealSelection, MealSlot, SLOT_KEYS, SlotMenu } from "./subscription.model.js";
import { weekdayOf } from "./subscription.rules.js";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLOT_NAMES = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };

export function toSlot(slot) {
  return {
    slotId: String(slot._id),
    kitchenId: String(slot.kitchen),
    key: slot.key,
    name: slot.name,
    windowStart: slot.windowStart,
    windowEnd: slot.windowEnd,
    cutoffDay: slot.cutoffDay,
    cutoffTime: slot.cutoffTime,
    prepStart: slot.prepStart,
    dispatchTime: slot.dispatchTime,
    capacity: slot.capacity || 0,
    activeDays: slot.activeDays,
    isActive: slot.isActive !== false,
  };
}

export async function listSlots(kitchenId, { activeOnly = false } = {}) {
  const slots = await MealSlot.find({ kitchen: kitchenId, ...(activeOnly ? { isActive: true } : {}) }).lean();
  return slots.sort((a, b) => SLOT_KEYS.indexOf(a.key) - SLOT_KEYS.indexOf(b.key)).map(toSlot);
}

/** Creates or replaces one slot of a kitchen. Every time is entered by the kitchen. */
export async function saveSlot(kitchenId, key, input) {
  if (!SLOT_KEYS.includes(key)) throw new AppError(404, "Unknown slot");
  const errors = [];
  for (const field of ["windowStart", "windowEnd", "cutoffTime", "prepStart", "dispatchTime"]) {
    if (!HHMM.test(input[field] || "")) errors.push({ field, message: `${field} must be HH:mm` });
  }
  if (!errors.length) {
    if (input.windowStart >= input.windowEnd) errors.push({ field: "windowEnd", message: "Window must end after it starts" });
    if ((input.cutoffDay || "same_day") === "same_day" && input.cutoffTime > input.prepStart) errors.push({ field: "cutoffTime", message: "Cutoff must be before preparation starts" });
    if (input.prepStart > input.dispatchTime) errors.push({ field: "dispatchTime", message: "Dispatch must be after preparation starts" });
  }
  if (input.activeDays !== undefined && (!Array.isArray(input.activeDays) || input.activeDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))) errors.push({ field: "activeDays", message: "Days are 0-6" });
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  const slot = await MealSlot.findOneAndUpdate(
    { kitchen: kitchenId, key },
    {
      $set: {
        name: (input.name || SLOT_NAMES[key]).slice(0, 30),
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        cutoffDay: input.cutoffDay === "previous_day" ? "previous_day" : "same_day",
        cutoffTime: input.cutoffTime,
        prepStart: input.prepStart,
        dispatchTime: input.dispatchTime,
        capacity: Number.isInteger(input.capacity) && input.capacity >= 0 ? input.capacity : 0,
        activeDays: input.activeDays || [0, 1, 2, 3, 4, 5, 6],
        isActive: input.isActive !== false,
      },
    },
    { upsert: true, new: true },
  );
  return toSlot(slot);
}

// ---- slot menus

export async function saveSlotMenu(kitchenId, { slot, date = null, weekday = null, dishIds = [], defaultDishIds = [], note = null }) {
  if (!SLOT_KEYS.includes(slot)) throw new AppError(422, "Unknown slot");
  if ((date == null) === (weekday == null)) throw new AppError(422, "Give either a date or a weekday");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(422, "Date must be YYYY-MM-DD");
  if (weekday != null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new AppError(422, "Weekday is 0-6");
  const ids = [...new Set(dishIds.map(String))];
  const found = await KitchenDish.countDocuments({ _id: { $in: ids.map((id) => objectId(id, "dish ID")) }, kitchen: kitchenId, isActive: true });
  if (found !== ids.length) throw new AppError(422, "Every dish must be on this kitchen's menu");
  const defaults = defaultDishIds.map(String).filter((id) => ids.includes(id));
  const menu = await SlotMenu.findOneAndUpdate(
    { kitchen: kitchenId, slot, date: date || null, weekday: weekday ?? null },
    { $set: { dishes: ids, defaultDishes: defaults, note } },
    { upsert: true, new: true },
  );
  return toSlotMenu(menu);
}

export async function deleteSlotMenu(kitchenId, menuId) {
  const deleted = await SlotMenu.findOneAndDelete({ _id: objectId(menuId, "menu ID"), kitchen: kitchenId });
  if (!deleted) throw new AppError(404, "Menu not found");
  return { menuId, deleted: true };
}

function toSlotMenu(menu) {
  return {
    menuId: String(menu._id),
    slot: menu.slot,
    date: menu.date,
    weekday: menu.weekday,
    dishIds: (menu.dishes || []).map(String),
    defaultDishIds: (menu.defaultDishes || []).map(String),
    note: menu.note,
  };
}

export async function listSlotMenus(kitchenId, { from = null, to = null } = {}) {
  const filter = { kitchen: kitchenId };
  const menus = await SlotMenu.find(filter).lean();
  return menus.filter((menu) => menu.weekday != null || ((!from || menu.date >= from) && (!to || menu.date <= to))).map(toSlotMenu);
}

/** The menu for a kitchen slot on a date: the dated menu, else the weekday template. */
export async function menuFor(kitchenId, slot, dateKey) {
  const dated = await SlotMenu.findOne({ kitchen: kitchenId, slot, date: dateKey }).lean();
  const menu = dated || await SlotMenu.findOne({ kitchen: kitchenId, slot, weekday: weekdayOf(dateKey) }).lean();
  if (!menu) return { dishes: [], defaultDishIds: [], note: null };
  const dishes = await KitchenDish.find({ _id: { $in: menu.dishes }, isActive: true }).lean();
  return { dishes: dishes.map((dish) => toDish(dish)), defaultDishIds: (menu.defaultDishes || []).map(String), note: menu.note || null };
}

// ---- production

/** What to cook and where it goes, for a kitchen, date and (optionally) slot. */
export async function productionSheet(kitchenId, { date = istDateKey(), slot = null } = {}) {
  const filter = { kitchen: objectId(kitchenId, "kitchen ID"), date, status: { $in: ["selected", "locked", "out_for_delivery", "delivered"] } };
  if (slot) filter.slot = slot;
  const meals = await MealSelection.find(filter).populate("user", "name phoneNumber").lean();
  const bySlot = {};
  for (const meal of meals) {
    const entry = bySlot[meal.slot] || (bySlot[meal.slot] = { slot: meal.slot, meals: 0, dishes: {}, drops: [] });
    entry.meals += 1;
    for (const item of meal.items || []) {
      const key = String(item.dish);
      entry.dishes[key] = entry.dishes[key] || { dishId: key, name: item.name, isVeg: item.isVeg !== false, qty: 0 };
      entry.dishes[key].qty += item.qty || 1;
    }
    entry.drops.push({
      mealId: String(meal._id),
      customer: meal.user?.name || "",
      phone: meal.user?.phoneNumber || "",
      address: meal.address?.fullAddress || "",
      items: (meal.items || []).map((item) => `${item.name} x${item.qty || 1}`).join(", "),
      status: meal.status,
    });
  }
  const [shifted, skipped] = await Promise.all([
    MealSelection.countDocuments({ kitchen: filter.kitchen, date, status: "shifted", ...(slot ? { slot } : {}) }),
    MealSelection.countDocuments({ kitchen: filter.kitchen, date, status: "skipped", ...(slot ? { slot } : {}) }),
  ]);
  return {
    date,
    slots: Object.values(bySlot).sort((a, b) => SLOT_KEYS.indexOf(a.slot) - SLOT_KEYS.indexOf(b.slot)).map((entry) => ({ ...entry, dishes: Object.values(entry.dishes).sort((a, b) => b.qty - a.qty) })),
    shifted,
    skipped,
    tomorrow: addIstDays(date, 1),
  };
}

export function productionPdf(sheet, kitchenName) {
  const doc = new PdfDocument();
  doc.line(`${kitchenName} – production sheet`, { size: 15, bold: true });
  doc.line(`Date ${sheet.date}   Shifted ${sheet.shifted}   Skipped ${sheet.skipped}`, { size: 9 });
  for (const slot of sheet.slots) {
    doc.rule();
    doc.line(`${slot.slot.toUpperCase()} – ${slot.meals} meal(s)`, { size: 12, bold: true });
    doc.table([{ header: "Dish", width: 300 }, { header: "Veg", width: 60 }, { header: "Quantity", width: 80, align: "right" }], slot.dishes.map((dish) => [dish.name, dish.isVeg ? "Veg" : "Non-veg", String(dish.qty)]));
    doc.space(8);
    doc.line("Drops", { size: 10, bold: true });
    doc.table([{ header: "Customer", width: 110 }, { header: "Phone", width: 80 }, { header: "Address", width: 210 }, { header: "Items", width: 115 }], slot.drops.map((drop) => [drop.customer, drop.phone, drop.address.slice(0, 48), drop.items.slice(0, 26)]), { size: 8 });
  }
  return doc.toBuffer();
}
