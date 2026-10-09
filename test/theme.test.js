import assert from "node:assert/strict";
import test from "node:test";
import { pickTheme, toHeaderTheme } from "../src/modules/content/theme.service.js";

const base = { _id: "default", name: "Meal Ji Indigo", isDefault: true, isActive: true, header: { backgroundColors: ["#2C40A6", "#192881"] }, promo: { title: "Foodie Weekend" } };
const halloween = { _id: "halloween", name: "Halloween", isActive: true, priority: 10, startsAt: "2026-10-24T18:30:00.000Z", endsAt: "2026-11-01T18:30:00.000Z", header: { backgroundColors: ["#FF7A00", "#1A0B2E"] }, promo: { title: "Spooky Bites" } };
const diwali = { _id: "diwali", name: "Diwali", isActive: true, priority: 20, startsAt: "2026-10-31T18:30:00.000Z", endsAt: "2026-11-10T18:30:00.000Z", header: { backgroundColors: ["#FFB300", "#7A1E00"] }, promo: { title: "Festival of Lights" } };
const at = (iso) => ({ now: new Date(iso) });

test("pickTheme: default outside any dated window", () => {
  assert.equal(pickTheme([base, halloween], at("2026-10-20T10:00:00Z"))._id, "default");
});

test("pickTheme: dated theme inside its window; end is exclusive", () => {
  assert.equal(pickTheme([base, halloween], at("2026-10-25T10:00:00Z"))._id, "halloween");
  assert.equal(pickTheme([base, halloween], at("2026-11-01T18:30:00Z"))._id, "default");
});

test("pickTheme: overlapping windows go to the higher priority", () => {
  assert.equal(pickTheme([base, halloween, diwali], at("2026-11-01T06:00:00Z"))._id, "diwali");
});

test("pickTheme: inactive and other-city themes are skipped", () => {
  assert.equal(pickTheme([base, { ...halloween, isActive: false }], at("2026-10-25T10:00:00Z"))._id, "default");
  const puneOnly = { ...halloween, cities: ["pune"] };
  assert.equal(pickTheme([base, puneOnly], { ...at("2026-10-25T10:00:00Z"), city: "Bengaluru" })._id, "default");
  assert.equal(pickTheme([base, puneOnly], { ...at("2026-10-25T10:00:00Z"), city: "Pune" })._id, "halloween");
});

test("pickTheme: nothing configured gives null; hidden promo is null in the app view", () => {
  assert.equal(pickTheme([], at("2026-10-25T10:00:00Z")), null);
  assert.equal(toHeaderTheme({ ...base, promo: { isVisible: false } }).promo, null);
  assert.equal(toHeaderTheme(base).header.statusBarStyle, "light");
});
