import assert from "node:assert/strict";
import { test } from "node:test";
import { addIstDays, istDateKey, istDateTime, istParts, isWithinIstWindow, startOfIstDay } from "../src/common/time.js";

test("IST date flips at 18:30 UTC", () => {
  assert.equal(istDateKey(new Date("2026-10-06T18:29:00Z")), "2026-10-06");
  assert.equal(istDateKey(new Date("2026-10-06T18:30:00Z")), "2026-10-07");
});

test("wall-clock IST time to instant", () => {
  assert.equal(istDateTime("2026-10-07", "10:00").toISOString(), "2026-10-07T04:30:00.000Z");
  assert.equal(startOfIstDay(new Date("2026-10-07T04:30:00Z")).toISOString(), "2026-10-06T18:30:00.000Z");
  assert.equal(istParts(new Date("2026-10-07T04:30:00Z")).time, "10:00");
});

test("adds days across month ends", () => {
  assert.equal(addIstDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addIstDays("2026-03-01", -1), "2026-02-28");
});

test("windows can wrap past midnight", () => {
  const at = (hhmm) => istDateTime("2026-10-07", hhmm);
  assert.equal(isWithinIstWindow(at("22:00"), "21:00", "09:00"), true);
  assert.equal(isWithinIstWindow(at("08:59"), "21:00", "09:00"), true);
  assert.equal(isWithinIstWindow(at("09:00"), "21:00", "09:00"), false);
  assert.equal(isWithinIstWindow(at("11:30"), "11:00", "15:00"), true);
  assert.throws(() => isWithinIstWindow(at("11:30"), "25:00", "15:00"));
});
