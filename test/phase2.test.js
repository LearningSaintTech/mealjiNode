import assert from "node:assert/strict";
import test from "node:test";
import { cutoffAt, nextServiceDay, noSelectionOutcome, pauseDates, servesOn, validateSelection } from "../src/modules/subscription/subscription.rules.js";
import { istDateTime } from "../src/common/time.js";

const sub = { status: "active", startDate: "2026-10-01", validTill: "2026-10-30", planSnapshot: { activeDays: [1, 2, 3, 4, 5, 6] } };

test("servesOn: range, pause window and plan days", () => {
  assert.equal(servesOn(sub, "2026-10-05"), true); // Monday
  assert.equal(servesOn(sub, "2026-10-04"), false); // Sunday is not a meal day
  assert.equal(servesOn(sub, "2026-10-31"), false); // after validTill
  assert.equal(servesOn({ ...sub, pause: { startsOn: "2026-10-10", resumesOn: "2026-11-09" } }, "2026-10-12"), false);
  assert.equal(servesOn({ ...sub, status: "past_due" }, "2026-10-05"), false);
});

test("cutoff: same day and previous day", () => {
  assert.deepEqual(cutoffAt({ cutoffDay: "same_day", cutoffTime: "10:00" }, "2026-10-07"), istDateTime("2026-10-07", "10:00"));
  assert.deepEqual(cutoffAt({ cutoffDay: "previous_day", cutoffTime: "21:00" }, "2026-10-07"), istDateTime("2026-10-06", "21:00"));
});

test("shifts land on the next meal day after the end", () => {
  assert.equal(nextServiceDay("2026-10-03", [1, 2, 3, 4, 5, 6]), "2026-10-05"); // Saturday → Monday
});

test("no-selection policy: auto-shift until the plan limit, then the fallback", () => {
  const plan = { noSelectionPolicy: "auto_shift", maxAutoShiftsPerCycle: 2, autoShiftFallback: "skip" };
  assert.equal(noSelectionOutcome(plan, { autoShiftsThisCycle: 1 }), "auto_shift");
  assert.equal(noSelectionOutcome(plan, { autoShiftsThisCycle: 2 }), "skip");
  assert.equal(noSelectionOutcome({ noSelectionPolicy: "chef_default" }, {}), "chef_default");
});

test("selection limits and menu membership", () => {
  const plan = { minItemsPerMeal: 1, maxItemsPerMeal: 3 };
  assert.equal(validateSelection([{ dishId: "a", qty: 4 }], { plan, menuDishIds: ["a"] }), "You can choose up to 3 item(s)");
  assert.equal(validateSelection([{ dishId: "x", qty: 1 }], { plan, menuDishIds: ["a"] }), "Some dishes are not on today's menu");
  assert.equal(validateSelection([{ dishId: "a", qty: 2 }], { plan, menuDishIds: ["a"] }), null);
});

test("pause starts at cycle end by default", () => {
  assert.deepEqual(pauseDates({ months: 1, startsMode: "cycle_end", currentPeriodEnd: "2026-10-30", today: "2026-10-07" }), { startsOn: "2026-10-31", resumesOn: "2026-11-30" });
});
