import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTING_DEFINITIONS } from "../src/modules/settings/settings.definitions.js";
import { applyPatch, defaultsOf, moneyFieldsChanged, normalizeCity, resolveLayers, validatePatch } from "../src/modules/settings/settings.resolver.js";

const policy = SETTING_DEFINITIONS.order_policy;
const app = SETTING_DEFINITIONS.app;

test("every definition has valid defaults", () => {
  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    const errors = validatePatch(definition, defaultsOf(definition));
    assert.deepEqual(errors, [], `${key} defaults are invalid`);
  }
});

test("most specific scope wins and sources are reported", () => {
  const { values, sources } = resolveLayers(policy, {
    global: { acceptSlaMinutes: 8, codEnabled: false },
    city: { acceptSlaMinutes: 6 },
    kitchen: { codEnabled: true },
  });
  assert.equal(values.acceptSlaMinutes, 6);
  assert.equal(sources.acceptSlaMinutes, "city");
  assert.equal(values.codEnabled, true);
  assert.equal(sources.codEnabled, "kitchen");
  assert.equal(values.acceptMode, "manual");
  assert.equal(sources.acceptMode, "default");
});

test("scopes a definition does not allow are ignored", () => {
  const { values } = resolveLayers(app, { global: { forceUpdate: true }, kitchen: { forceUpdate: false } });
  assert.equal(values.forceUpdate, true);
});

test("validation catches type, range, enum and unknown fields", () => {
  const errors = validatePatch(policy, {
    acceptSlaMinutes: 0,
    codEnabled: "yes",
    acceptMode: "sometimes",
    minOrderPaise: 10.5,
    bogus: 1,
  });
  const fields = errors.map((error) => error.field).sort();
  assert.deepEqual(fields, ["acceptMode", "acceptSlaMinutes", "bogus", "codEnabled", "minOrderPaise"]);
});

test("kitchen admins can only edit kitchen-editable fields", () => {
  assert.equal(validatePatch(policy, { codEnabled: false }, { kitchenOnly: true }).length, 0);
  const errors = validatePatch(policy, { autoCancelAfterMinutes: 30 }, { kitchenOnly: true });
  assert.equal(errors[0].field, "autoCancelAfterMinutes");
});

test("null removes an override", () => {
  assert.deepEqual(applyPatch({ a: 1, b: 2 }, { a: null, c: 3 }), { b: 2, c: 3 });
  assert.deepEqual(validatePatch(policy, { codEnabled: null }), []);
});

test("money changes are detected and city names normalised", () => {
  assert.equal(moneyFieldsChanged(policy, { minOrderPaise: 100 }), true);
  assert.equal(moneyFieldsChanged(policy, { codEnabled: true }), false);
  assert.equal(normalizeCity("  Greater   Noida "), "greater noida");
});
