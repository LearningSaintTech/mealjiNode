import { addIstDays, istDateTime, istParts } from "../../common/time.js";

// Pure subscription and meal-plan rules (dates are IST YYYY-MM-DD keys).

export function weekdayOf(dateKey) {
  return istParts(istDateTime(dateKey, "12:00")).weekday;
}

export function daysBetween(fromKey, toKey) {
  return Math.round((istDateTime(toKey) - istDateTime(fromKey)) / 86_400_000);
}

/** A cycle starting on `startKey` runs `cycleDays` days: [start, end]. */
export function cycleRange(startKey, cycleDays) {
  return { start: startKey, end: addIstDays(startKey, cycleDays - 1) };
}

/** Instant the selection closes for a slot on a date. */
export function cutoffAt(slot, dateKey) {
  const day = slot.cutoffDay === "previous_day" ? addIstDays(dateKey, -1) : dateKey;
  return istDateTime(day, slot.cutoffTime);
}

/** Whether the subscription has a meal on this date (status, range, plan days). */
export function servesOn(subscription, dateKey) {
  if (!["active", "pause_scheduled", "cancel_scheduled", "past_due"].includes(subscription.status)) return false;
  if (subscription.status === "past_due") return false;
  if (dateKey < subscription.startDate || (subscription.validTill && dateKey > subscription.validTill)) return false;
  if (subscription.pause?.startsOn && dateKey >= subscription.pause.startsOn && (!subscription.pause.resumesOn || dateKey < subscription.pause.resumesOn)) return false;
  const days = subscription.planSnapshot?.activeDays;
  return !days?.length || days.includes(weekdayOf(dateKey));
}

/** The next meal day after `dateKey` on the plan's active days (for shifts). */
export function nextServiceDay(dateKey, activeDays = []) {
  let day = addIstDays(dateKey, 1);
  for (let i = 0; i < 14; i += 1) {
    if (!activeDays.length || activeDays.includes(weekdayOf(day))) return day;
    day = addIstDays(day, 1);
  }
  return day;
}

/** Validates a meal selection against the plan limits and the slot menu. */
export function validateSelection(items, { plan, menuDishIds }) {
  const total = items.reduce((sum, item) => sum + (item.qty || 1), 0);
  if (total < (plan.minItemsPerMeal || 1)) return `Choose at least ${plan.minItemsPerMeal || 1} item(s)`;
  if (total > plan.maxItemsPerMeal) return `You can choose up to ${plan.maxItemsPerMeal} item(s)`;
  const allowed = new Set(menuDishIds.map(String));
  if (items.some((item) => !allowed.has(String(item.dishId)))) return "Some dishes are not on today's menu";
  return null;
}

/**
 * What happens to a slot nobody filled in by the cutoff, given the plan policy
 * and how many automatic shifts were already used this cycle.
 */
export function noSelectionOutcome(plan, { autoShiftsThisCycle = 0 }) {
  const policy = plan.noSelectionPolicy || "auto_shift";
  if (policy !== "auto_shift") return policy;
  if (plan.maxAutoShiftsPerCycle > 0 && autoShiftsThisCycle >= plan.maxAutoShiftsPerCycle) return plan.autoShiftFallback || "skip";
  return "auto_shift";
}

/** Pause dates from the request and settings. */
export function pauseDates({ months, startsMode, currentPeriodEnd, today }) {
  const startsOn = startsMode === "next_day" ? addIstDays(today, 1) : addIstDays(currentPeriodEnd, 1);
  return { startsOn, resumesOn: addIstDays(startsOn, months * 30) };
}
