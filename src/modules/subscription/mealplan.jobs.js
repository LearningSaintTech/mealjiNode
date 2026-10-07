import { addIstDays, istDateKey } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { storeSetNx } from "../../infrastructure/redisStore.js";
import { resolveSetting } from "../settings/settings.service.js";
import { ensureMeal, shiftMeals } from "./mealplan.service.js";
import { MealSelection, MealSlot, Subscription } from "./subscription.model.js";
import { cutoffAt, noSelectionOutcome, servesOn, weekdayOf } from "./subscription.rules.js";
import { menuFor } from "./slot.service.js";

const once = async (key, ttlSec) => {
  try {
    return await storeSetNx(key, "1", ttlSec);
  } catch {
    return true;
  }
};

async function fillFrom(meal, dishes) {
  if (!dishes.length) return false;
  meal.items = dishes.map((dish) => ({ dish: dish.dishId || dish.dish, name: dish.name, qty: dish.qty || 1, isVeg: dish.isVeg !== false }));
  return true;
}

/**
 * Applies the plan's no-selection policy to an empty meal at its cutoff:
 * auto_shift (default) moves it after the end date; chef_default fills the
 * kitchen's default; repeat_last copies the last chosen meal for the slot;
 * skip drops it.
 */
async function applyNoSelection(sub, slot, meal) {
  const outcome = noSelectionOutcome(sub.planSnapshot, sub);
  if (outcome === "auto_shift") {
    await shiftMeals(sub, { date: meal.date, slot: slot.key, kind: "auto" });
    return "auto_shift";
  }
  if (outcome === "chef_default") {
    const menu = await menuFor(sub.kitchen, slot.key, meal.date);
    const defaults = menu.dishes.filter((dish) => menu.defaultDishIds.includes(dish.dishId)).slice(0, sub.planSnapshot.maxItemsPerMeal);
    if (await fillFrom(meal, defaults)) {
      meal.source = "chef_default";
      meal.status = "locked";
      return "chef_default";
    }
  }
  if (outcome === "repeat_last") {
    const last = await MealSelection.findOne({ subscription: sub._id, slot: slot.key, source: "customer", items: { $ne: [] } }).sort({ date: -1 }).lean();
    if (last && await fillFrom(meal, last.items.map((item) => ({ dish: item.dish, name: item.name, qty: item.qty, isVeg: item.isVeg })))) {
      meal.source = "repeat_last";
      meal.status = "locked";
      return "repeat_last";
    }
  }
  meal.status = "skipped";
  return "skip";
}

/**
 * Every minute: for each active kitchen slot, send selection reminders before
 * the cutoff, then at the cutoff lock chosen meals and apply the policy to empty
 * ones. Work for a (kitchen, slot, date) runs once (Redis guard + status checks).
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
        const subs = await Subscription.find({ kitchen: slot.kitchen, status: { $in: ["active", "pause_scheduled", "cancel_scheduled"] }, "planSnapshot.slots": slot.key }).lean();
        for (const sub of subs) {
          if (!servesOn(sub, date)) continue;
          const meal = await MealSelection.findOne({ subscription: sub._id, date, slot: slot.key }).lean();
          if (meal && meal.status !== "open") continue;
          await publishEventSafe("meal.selection_due", { userId: String(sub.user), subscriptionId: String(sub._id), date, slot: slot.key, slotName: slot.name, cutoffAt: cutoff, minutesLeft: minutes });
        }
      }

      // After the cutoff: re-check every 10 minutes for 12 hours (each meal's
      // own status keeps this idempotent), so late changes are still handled.
      if (now < cutoff || now - cutoff > 12 * 3600_000) continue;
      if (!(await once(`meal:cutoff:${slot._id}:${date}:${Math.floor(now.getTime() / 600_000)}`, 900))) continue;
      const subs = await Subscription.find({ kitchen: slot.kitchen, status: { $in: ["active", "pause_scheduled", "cancel_scheduled"] }, "planSnapshot.slots": slot.key });
      for (const sub of subs) {
        if (!servesOn(sub, date)) continue;
        try {
          const meal = await ensureMeal(sub, slot, date);
          if (meal.status === "selected") {
            meal.status = "locked";
            meal.lockedAt = now;
            meal.timeline.push({ status: "locked", at: now });
            await meal.save();
            await publishEventSafe("meal.locked", { userId: String(sub.user), mealId: String(meal._id), date, slot: slot.key, slotName: slot.name, items: meal.items.map((item) => `${item.name} x${item.qty}`).join(", ") });
          } else if (meal.status === "open") {
            const outcome = await applyNoSelection(sub, slot, meal);
            if (outcome !== "auto_shift") {
              meal.lockedAt = now;
              meal.timeline.push({ status: meal.status, at: now });
              await meal.save();
            }
            await publishEventSafe(outcome === "auto_shift" ? "meal.auto_shifted" : "meal.no_selection", { userId: String(sub.user), subscriptionId: String(sub._id), date, slot: slot.key, slotName: slot.name, outcome, shiftedTo: outcome === "auto_shift" ? sub.validTill : null });
          }
          handled += 1;
        } catch (err) {
          logger.warn({ err: err.message, subscriptionId: String(sub._id), date, slot: slot.key }, "Meal cutoff failed for a subscriber");
        }
      }
    }
  }
  return handled;
}
