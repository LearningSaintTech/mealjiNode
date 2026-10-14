import { addIstDays, istDateKey } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { storeDel, storeSetNx } from "../../infrastructure/redisStore.js";
import { resolveSetting } from "../settings/settings.service.js";
import { allowedDishes, shiftMeals, slotServes } from "./mealplan.service.js";
import { MealSelection, MealSlot, Subscription } from "./subscription.model.js";
import { cutoffAt, noSelectionOutcome, weekdayOf } from "./subscription.rules.js";
import { menuFor } from "./slot.service.js";

const once = async (key, ttlSec) => {
  try {
    return await storeSetNx(key, "1", ttlSec);
  } catch {
    return true;
  }
};

const MEMBER_STATUSES = ["active", "pause_scheduled", "cancel_scheduled"];
// Only what deciding "is a meal due" and creating its row need.
const MEMBER_FIELDS = "_id user kitchen status startDate validTill currentPeriodStart currentPeriodEnd pause address planSnapshot.activeDays planSnapshot.slots";

/** Members of a kitchen whose plan includes this slot, as light read-only rows. */
function membersFor(slot) {
  return Subscription.find({ kitchen: slot.kitchen, status: { $in: MEMBER_STATUSES }, "planSnapshot.slots": slot.key }).select(MEMBER_FIELDS).lean();
}

/** At the cutoff: one row for every member who is due this meal and has none yet (one insert). */
async function ensureRows(slot, date) {
  const [members, stored] = await Promise.all([
    membersFor(slot),
    MealSelection.find({ kitchen: slot.kitchen, date, slot: slot.key }).select("subscription shiftedFrom").lean(),
  ]);
  const have = new Map(stored.map((row) => [String(row.subscription), row]));
  const cutoff = cutoffAt(slot, date);
  const rows = members
    .filter((sub) => !have.has(String(sub._id)) && slotServes(sub, slot, date, null))
    .map((sub) => ({ subscription: sub._id, user: sub.user, kitchen: sub.kitchen, date, slot: slot.key, cutoffAt: cutoff, address: sub.address, timeline: [{ status: "open", at: new Date() }] }));
  if (rows.length) {
    await MealSelection.insertMany(rows, { ordered: false }).catch((err) => {
      if (!(err?.code === 11000 || err?.writeErrors?.every((item) => item.code === 11000 || item.err?.code === 11000))) throw err;
    });
  }
  return rows.length;
}

/**
 * What a meal nobody chose becomes at its cutoff, given the plan policy:
 * auto_shift (default) moves it after the end date; chef_default fills the
 * kitchen's default; repeat_last copies the last chosen meal for the slot;
 * skip drops it. A meal already on an extra day, or on a plan that is ending,
 * is never moved again (the plan would otherwise never end): it gets the
 * fallback instead. Every write only applies while the meal is still open.
 */
async function applyNoSelection(sub, slot, meal, now) {
  let outcome = noSelectionOutcome(sub.planSnapshot, sub);
  if (outcome === "auto_shift" && (meal.shiftedFrom || sub.status === "cancel_scheduled")) outcome = sub.planSnapshot.autoShiftFallback || "skip";
  if (outcome === "auto_shift") {
    try {
      const result = await shiftMeals(sub, { date: meal.date, slot: slot.key, kind: "auto" });
      return { outcome, shiftedTo: result.slots.find((item) => item.slot === slot.key)?.shiftedTo || result.shiftedTo };
    } catch (err) {
      // Could not move it (already moved, chosen at the last second, or busy): fall back.
      logger.info({ err: err.message, mealId: String(meal._id) }, "Auto shift not done; using the fallback");
      outcome = sub.planSnapshot.autoShiftFallback || "skip";
    }
  }
  let set = null;
  if (outcome === "chef_default") {
    const menu = await menuFor(sub.kitchen, slot.key, meal.date);
    const defaults = allowedDishes(sub, menu.dishes).filter((dish) => menu.defaultDishIds.includes(dish.dishId)).slice(0, sub.planSnapshot.maxItemsPerMeal);
    if (defaults.length) set = { items: defaults.map((dish) => ({ dish: dish.dishId, name: dish.name, qty: 1, isVeg: dish.isVeg !== false })), source: "chef_default", status: "locked" };
  }
  if (outcome === "repeat_last") {
    const last = await MealSelection.findOne({ subscription: sub._id, slot: slot.key, source: "customer", items: { $ne: [] } }).sort({ date: -1 }).lean();
    if (last) set = { items: last.items.map((item) => ({ dish: item.dish, name: item.name, qty: item.qty, isVeg: item.isVeg })), source: "repeat_last", status: "locked" };
  }
  if (!set) {
    set = { status: "skipped" };
    outcome = "skip";
  }
  const updated = await MealSelection.updateOne({ _id: meal._id, status: "open" }, { $set: { ...set, lockedAt: now }, $push: { timeline: { status: set.status, at: now } } });
  return { outcome, applied: updated.modifiedCount > 0 };
}

/**
 * Every minute: for each active kitchen slot, send selection reminders before
 * the cutoff, then at the cutoff lock chosen meals and apply the policy to empty
 * ones. Rows for everyone due are created once at the cutoff; after that each
 * 10-minute pass only reads the meals still open or chosen (indexed by
 * kitchen, date, slot, status), so the cost does not grow with every member.
 */
export async function mealCutoffRun() {
  const now = new Date();
  const today = istDateKey();
  const slots = await MealSlot.find({ isActive: true }).lean();
  let handled = 0;
  for (const slot of slots) {
    for (const date of [today, addIstDays(today, 1)]) {
      if (!(slot.activeDays || []).includes(weekdayOf(date))) continue;
      const cutoff = cutoffAt(slot, date);
      const policy = (await resolveSetting("subscription_policy", { kitchenId: slot.kitchen })).values;

      // Reminders (cutoff − N minutes) for subscribers who have not chosen yet.
      for (const minutes of policy.selectionReminderMinutes || []) {
        const at = new Date(cutoff.getTime() - minutes * 60_000);
        if (now < at || now >= cutoff) continue;
        if (!(await once(`meal:remind:${slot._id}:${date}:${minutes}`, 2 * 86_400))) continue;
        const [members, rows] = await Promise.all([
          membersFor(slot),
          MealSelection.find({ kitchen: slot.kitchen, date, slot: slot.key }).select("subscription status shiftedFrom").lean(),
        ]);
        const bySub = new Map(rows.map((row) => [String(row.subscription), row]));
        for (const sub of members) {
          const row = bySub.get(String(sub._id)) || null;
          if (row && row.status !== "open") continue;
          if (!slotServes(sub, slot, date, row)) continue;
          await publishEventSafe("meal.selection_due", { userId: String(sub.user), subscriptionId: String(sub._id), date, slot: slot.key, slotName: slot.name, cutoffAt: cutoff, minutesLeft: minutes });
        }
      }

      // After the cutoff: re-check every 10 minutes for 12 hours (each meal's
      // own status keeps this idempotent), so late changes are still handled.
      if (now < cutoff || now - cutoff > 12 * 3600_000) continue;
      if (!(await once(`meal:cutoff:${slot._id}:${date}:${Math.floor(now.getTime() / 600_000)}`, 900))) continue;
      const rowsKey = `meal:rows:${slot._id}:${date}`;
      if (await once(rowsKey, 2 * 86_400)) {
        try {
          await ensureRows(slot, date);
        } catch (err) {
          await storeDel(rowsKey).catch(() => {});
          logger.warn({ err: err.message, slot: slot.key, date }, "Meal rows not created; retried next pass");
          continue;
        }
      }

      // Chosen meals are locked (only while still chosen).
      const chosen = await MealSelection.find({ kitchen: slot.kitchen, date, slot: slot.key, status: "selected" }).select("_id user items").lean();
      for (const meal of chosen) {
        const locked = await MealSelection.updateOne({ _id: meal._id, status: "selected" }, { $set: { status: "locked", lockedAt: now }, $push: { timeline: { status: "locked", at: now } } });
        if (!locked.modifiedCount) continue;
        await publishEventSafe("meal.locked", { userId: String(meal.user), mealId: String(meal._id), date, slot: slot.key, slotName: slot.name, items: meal.items.map((item) => `${item.name} x${item.qty}`).join(", ") });
        handled += 1;
      }

      // Meals nobody chose get the plan's policy.
      const empty = await MealSelection.find({ kitchen: slot.kitchen, date, slot: slot.key, status: "open" }).lean();
      for (const meal of empty) {
        try {
          const sub = await Subscription.findById(meal.subscription);
          if (!sub || !MEMBER_STATUSES.includes(sub.status) || !slotServes(sub, slot, date, meal)) {
            // The plan was paused, cancelled or ended meanwhile: nothing to cook.
            await MealSelection.updateOne({ _id: meal._id, status: "open" }, { $set: { status: "skipped", lockedAt: now }, $push: { timeline: { status: "skipped", at: now } } });
            continue;
          }
          const result = await applyNoSelection(sub, slot, meal, now);
          await publishEventSafe(result.outcome === "auto_shift" ? "meal.auto_shifted" : "meal.no_selection", { userId: String(sub.user), subscriptionId: String(sub._id), date, slot: slot.key, slotName: slot.name, outcome: result.outcome, shiftedTo: result.shiftedTo || null });
          handled += 1;
        } catch (err) {
          logger.warn({ err: err.message, mealId: String(meal._id), date, slot: slot.key }, "Meal cutoff failed for a subscriber");
        }
      }
    }
  }
  return handled;
}
