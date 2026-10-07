import { SCOPE_ORDER } from "./settings.definitions.js";

// Pure functions (no database) so the rules are unit-tested.

const VERSION = /^\d+\.\d+\.\d+$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function defaultsOf(definition) {
  return Object.fromEntries(definition.fields.map((field) => [field.key, field.default]));
}

function checkRange(field, value, errors) {
  if (field.min != null && value < field.min) errors.push({ field: field.key, message: `${field.label} must be at least ${field.min}` });
  if (field.max != null && value > field.max) errors.push({ field: field.key, message: `${field.label} must be at most ${field.max}` });
}

export function validateField(field, value) {
  const errors = [];
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") errors.push({ field: field.key, message: `${field.label} must be true or false` });
      break;
    case "integer":
    case "money":
      if (!Number.isInteger(value)) {
        errors.push({ field: field.key, message: field.type === "money" ? `${field.label} must be a whole number of paise` : `${field.label} must be a whole number` });
      } else {
        checkRange(field, value, errors);
      }
      break;
    case "string":
    case "text":
      if (typeof value !== "string") errors.push({ field: field.key, message: `${field.label} must be text` });
      else if (field.maxLength && value.length > field.maxLength) errors.push({ field: field.key, message: `${field.label} must be at most ${field.maxLength} characters` });
      break;
    case "enum":
      if (!field.options.some((option) => option.value === value)) errors.push({ field: field.key, message: `${field.label} has an invalid value` });
      break;
    case "multiEnum":
      if (!Array.isArray(value) || value.some((item) => !field.options.some((option) => option.value === item))) {
        errors.push({ field: field.key, message: `${field.label} has an invalid value` });
      }
      break;
    case "time":
      if (typeof value !== "string" || !HHMM.test(value)) errors.push({ field: field.key, message: `${field.label} must be HH:mm` });
      break;
    case "version":
      if (typeof value !== "string" || !VERSION.test(value)) errors.push({ field: field.key, message: `${field.label} must look like 1.2.3` });
      break;
    case "decimal":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({ field: field.key, message: `${field.label} must be a number` });
      } else {
        checkRange(field, value, errors);
      }
      break;
    case "moneyList":
      if (!Array.isArray(value) || value.length > (field.maxItems || 10) || value.some((item) => !Number.isInteger(item) || item < 0)) {
        errors.push({ field: field.key, message: `${field.label} must be up to ${field.maxItems || 10} amounts in paise` });
      }
      break;
    case "stringList":
      if (!Array.isArray(value) || value.length > (field.maxItems || 20)
        || value.some((item) => typeof item !== "string" || !item.trim() || item.length > (field.maxLength || 80))) {
        errors.push({ field: field.key, message: `${field.label} must be up to ${field.maxItems || 20} short texts` });
      }
      break;
    case "slabs": {
      // Distance slabs: [{ uptoKm, feePaise }] in increasing distance.
      const valid = Array.isArray(value) && value.length <= 20 && value.every((slab, index) => slab
        && typeof slab.uptoKm === "number" && slab.uptoKm > 0 && slab.uptoKm <= 100
        && Number.isInteger(slab.feePaise) && slab.feePaise >= 0
        && (index === 0 || slab.uptoKm > value[index - 1].uptoKm));
      if (!valid) errors.push({ field: field.key, message: `${field.label} must be distance slabs in increasing km with fees in paise` });
      break;
    }
    default:
      errors.push({ field: field.key, message: `${field.label} has an unsupported type` });
  }
  return errors;
}

/**
 * Validates a patch for one scope. A value of `null` removes the override at
 * that scope (or resets to the default at global scope). `kitchenOnly`
 * restricts the patch to fields the kitchen admin may edit.
 */
export function validatePatch(definition, patch, { kitchenOnly = false } = {}) {
  const errors = [];
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return [{ field: "values", message: "values must be an object" }];
  }
  const byKey = new Map(definition.fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(patch)) {
    const field = byKey.get(key);
    if (!field) {
      errors.push({ field: key, message: `Unknown setting "${key}"` });
      continue;
    }
    if (kitchenOnly && !field.kitchenEditable) {
      errors.push({ field: key, message: `${field.label} can only be changed by the platform admin` });
      continue;
    }
    if (value === null) continue;
    errors.push(...validateField(field, value));
  }
  if (!Object.keys(patch).length) errors.push({ field: "values", message: "Nothing to change" });
  return errors;
}

// The stored values for a scope after applying a patch.
export function applyPatch(current, patch) {
  const next = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Merges defaults with each scope's stored values, most specific last.
 * `layers` is `{ global, city, kitchen }` of stored values (or null).
 * Returns the effective values and, per field, which scope supplied it.
 */
export function resolveLayers(definition, layers) {
  const values = defaultsOf(definition);
  const sources = Object.fromEntries(definition.fields.map((field) => [field.key, "default"]));
  for (const scope of SCOPE_ORDER) {
    if (!definition.scopes.includes(scope)) continue;
    const stored = layers?.[scope];
    if (!stored) continue;
    for (const field of definition.fields) {
      if (Object.prototype.hasOwnProperty.call(stored, field.key) && stored[field.key] !== undefined) {
        values[field.key] = stored[field.key];
        sources[field.key] = scope;
      }
    }
  }
  return { values, sources };
}

const MONEY_TYPES = new Set(["money", "moneyList", "slabs"]);

export function moneyFieldsChanged(definition, patch) {
  return definition.fields.some((field) => (MONEY_TYPES.has(field.type) || field.money) && Object.prototype.hasOwnProperty.call(patch, field.key));
}

/**
 * Applies platform-set kitchen limits to a definition: per field, whether the
 * kitchen may override it and the min/max it must stay within. Limits can only
 * narrow what the definition allows for numbers, never widen it.
 */
export function applyLimits(definition, limits) {
  if (!limits) return definition;
  return {
    ...definition,
    fields: definition.fields.map((field) => {
      const limit = limits[field.key];
      if (!limit) return field;
      const next = { ...field };
      if (typeof limit.kitchenEditable === "boolean") next.kitchenEditable = limit.kitchenEditable;
      if (typeof limit.min === "number") next.min = field.min == null ? limit.min : Math.max(field.min, limit.min);
      if (typeof limit.max === "number") next.max = field.max == null ? limit.max : Math.min(field.max, limit.max);
      return next;
    }),
  };
}

export function normalizeCity(city) {
  return String(city || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Orders versions the way they take effect: by start time, then by version.
export function byEffectiveOrder(a, b) {
  const diff = new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime();
  return diff || a.version - b.version;
}

/**
 * The stored values at one scope at instant `at`: every version that has
 * started, applied in effective order. Versions with a `patch` apply just that
 * change; legacy versions carry a full `values` snapshot that replaces the state.
 */
export function foldVersions(versions, at = new Date()) {
  const cutoff = new Date(at).getTime();
  let state = null;
  for (const version of [...versions].sort(byEffectiveOrder)) {
    if (new Date(version.effectiveFrom).getTime() > cutoff) continue;
    state = version.patch ? applyPatch(state || {}, version.patch) : { ...(version.values || {}) };
  }
  return state;
}

// The change a version made: its patch, or for a legacy snapshot the
// difference from the previous state (removed keys show as null).
export function versionChanges(version, previousState) {
  if (version.patch) return version.patch;
  const before = previousState || {};
  const after = version.values || {};
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = key in after ? after[key] : null;
  }
  return changes;
}
