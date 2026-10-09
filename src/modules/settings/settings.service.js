import { env } from "../../config/env.js";
import { AppError } from "../../common/errors/AppError.js";
import { BUSINESS_TIMEZONE } from "../../common/time.js";
import { withTransaction } from "../../config/database.js";
import { logger } from "../../config/logger.js";
import { isKitchenRole } from "../../constants/permissions.js";
import { publishEvent } from "../../events/eventBus.js";
import { storeDel, storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { recordAudit } from "../audit/audit.service.js";
import { kitchenRepository } from "../kitchen/kitchen.repository.js";
import { getDefinition, listDefinitions } from "./settings.definitions.js";
import { Setting } from "./settings.model.js";
import { SettingLimit } from "./settingLimit.model.js";
import { memoCache } from "../../common/memoCache.js";
import {
  applyLimits,
  applyPatch,
  byEffectiveOrder,
  defaultsOf,
  foldVersions,
  moneyFieldsChanged,
  normalizeCity,
  resolveLayers,
  validatePatch,
  versionChanges,
} from "./settings.resolver.js";

// Short TTL so a version scheduled for the future takes effect within a minute
// even if the activation job is late. Writes delete the key immediately.
const CACHE_TTL_SEC = 60;
const cacheKey = (key, scopeType, scopeId) => `settings:scope:${key}:${scopeType}:${scopeId}`;

function requireDefinition(key) {
  const definition = getDefinition(key);
  if (!definition) throw new AppError(404, "Setting not found");
  return definition;
}

const limitsKey = (key) => `settings:limits:${key}`;

/** Platform-set kitchen override limits for one group ({} when none). */
export async function getLimits(key) {
  requireDefinition(key);
  const cached = await storeGetOptional(limitsKey(key));
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const doc = await SettingLimit.findOne({ key }).lean();
  const fields = doc?.fields || {};
  await storeSet(limitsKey(key), JSON.stringify(fields), CACHE_TTL_SEC).catch(() => {});
  return fields;
}

// The definition as a kitchen admin sees it: platform limits applied.
async function kitchenDefinition(key) {
  return applyLimits(requireDefinition(key), await getLimits(key));
}

/**
 * Sets which fields kitchens may override and within what range. `fields` maps
 * a field key to `{ kitchenEditable, min, max }`; `null` clears a field's limit.
 */
export async function setLimits(key, fields, { req } = {}) {
  const definition = requireDefinition(key);
  if (!definition.scopes.includes("kitchen")) throw new AppError(422, "This setting has no kitchen level");
  const byKey = new Map(definition.fields.map((field) => [field.key, field]));
  const errors = [];
  const current = await getLimits(key);
  const next = { ...current };
  for (const [fieldKey, limit] of Object.entries(fields || {})) {
    const field = byKey.get(fieldKey);
    if (!field) {
      errors.push({ field: fieldKey, message: `Unknown setting "${fieldKey}"` });
      continue;
    }
    if (limit === null) {
      delete next[fieldKey];
      continue;
    }
    const clean = {};
    if (typeof limit.kitchenEditable === "boolean") clean.kitchenEditable = limit.kitchenEditable;
    for (const bound of ["min", "max"]) {
      if (limit[bound] == null) continue;
      if (!["integer", "money", "decimal"].includes(field.type) || typeof limit[bound] !== "number") {
        errors.push({ field: fieldKey, message: `${field.label} has no ${bound} to set` });
      } else {
        clean[bound] = limit[bound];
      }
    }
    if (clean.min != null && clean.max != null && clean.min > clean.max) {
      errors.push({ field: fieldKey, message: `${field.label}: min is above max` });
    }
    next[fieldKey] = clean;
  }
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  await SettingLimit.updateOne(
    { key },
    { $set: { fields: next, updatedBy: { userId: req?.auth?.userId || null, name: req?.auth?.user?.name || null } } },
    { upsert: true },
  );
  await storeDel(limitsKey(key)).catch(() => {});
  await recordAudit(req, {
    action: "settings.limits_changed",
    entityType: "setting",
    entityId: `${key}:limits`,
    summary: `Kitchen limits for ${definition.title}`,
    before: current,
    after: next,
  });
  return { key, fields: next, definition: applyLimits(definition, next).fields };
}

async function scopeVersions(key, scopeType, scopeId) {
  return Setting.find({ key, scopeType, scopeId }).sort({ effectiveFrom: 1, version: 1 }).lean();
}

async function scopeValuesFromDb(key, scopeType, scopeId, at = new Date()) {
  return foldVersions(await scopeVersions(key, scopeType, scopeId), at);
}

async function scopeValues(key, scopeType, scopeId) {
  const cached = await storeGetOptional(cacheKey(key, scopeType, scopeId));
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const values = await scopeValuesFromDb(key, scopeType, scopeId);
  await storeSet(cacheKey(key, scopeType, scopeId), JSON.stringify(values), CACHE_TTL_SEC).catch(() => {});
  return values;
}

// The public app config is read on every app launch: cached 30 s per instance,
// cleared whenever a setting changes here.
const appConfigCache = memoCache(30_000);

async function invalidate(key, scopeType, scopeId) {
  await storeDel(cacheKey(key, scopeType, scopeId)).catch(() => {});
  appConfigCache.clear();
  resolvedCache.clear();
}

async function kitchenContext(kitchenId) {
  const kitchen = await kitchenRepository.findActiveById(kitchenId);
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  return { kitchenId: String(kitchen._id), city: normalizeCity(kitchen.city), name: kitchen.name };
}

/**
 * The values in force for a context. Pass `{ kitchenId }` (its city is looked
 * up) or `{ city }`. This is what business code calls, e.g.
 * `resolveSetting("order_policy", { kitchenId })`.
 */
// Resolved settings are read many times per request (home, delivery checks):
// kept in memory for 5 s per key + city + kitchen, cleared on any setting change.
const resolvedCache = memoCache(5_000);

export function resolveSetting(key, { kitchenId = null, city = null } = {}) {
  requireDefinition(key);
  return resolvedCache.get(`${key}|${city ? normalizeCity(city) : ""}|${kitchenId || ""}`, () => resolveSettingFresh(key, { kitchenId, city }));
}

async function resolveSettingFresh(key, { kitchenId = null, city = null } = {}) {
  const definition = requireDefinition(key);
  let resolvedCity = city ? normalizeCity(city) : null;
  if (kitchenId && !resolvedCity) resolvedCity = (await kitchenContext(kitchenId)).city;

  const layers = { global: await scopeValues(key, "global", "") };
  if (resolvedCity && definition.scopes.includes("city")) layers.city = await scopeValues(key, "city", resolvedCity);
  if (kitchenId && definition.scopes.includes("kitchen")) layers.kitchen = await scopeValues(key, "kitchen", String(kitchenId));
  return resolveLayers(definition, layers);
}

async function normalizeScope(definition, scopeType = "global", scopeId = "") {
  if (!definition.scopes.includes(scopeType)) {
    throw new AppError(422, `This setting cannot be set per ${scopeType}`);
  }
  if (scopeType === "global") return { scopeType, scopeId: "", context: {} };
  if (scopeType === "city") {
    const city = normalizeCity(scopeId);
    if (!city) throw new AppError(422, "City is required");
    return { scopeType, scopeId: city, context: { city } };
  }
  const kitchen = await kitchenContext(scopeId);
  return { scopeType, scopeId: kitchen.kitchenId, context: { kitchenId: kitchen.kitchenId, city: kitchen.city }, kitchen };
}

function pick(object, keys) {
  if (!object) return object;
  return Object.fromEntries(Object.entries(object).filter(([key]) => keys.has(key)));
}

export async function listSettingDefinitions({ kitchenOnly = false } = {}) {
  const definitions = kitchenOnly
    ? await Promise.all(listDefinitions().map(async (definition) => ({ ...(await kitchenDefinition(definition.key)), key: definition.key })))
    : listDefinitions();
  return definitions
    .map((definition) => ({
      key: definition.key,
      title: definition.title,
      description: definition.description,
      group: definition.group,
      permission: definition.permission,
      scopes: definition.scopes,
      fields: kitchenOnly ? definition.fields.filter((field) => field.kitchenEditable) : definition.fields,
    }))
    .filter((definition) => !kitchenOnly || (definition.scopes.includes("kitchen") && definition.fields.length));
}

/**
 * Everything the console needs to edit one setting at one scope: the stored
 * values at that scope, the effective values (with inheritance), where each
 * value comes from, scheduled future versions, and recent history. Each
 * version lists only the fields it changed. For kitchen admins everything is
 * limited to the fields they may edit, and platform authors are not named.
 */
export async function getSettingDetail(key, { scopeType = "global", scopeId = "", kitchenOnly = false } = {}) {
  const definition = kitchenOnly ? await kitchenDefinition(key) : requireDefinition(key);
  const scope = await normalizeScope(definition, scopeType, scopeId);
  const now = new Date();

  const [versions, effective] = await Promise.all([
    scopeVersions(key, scope.scopeType, scope.scopeId),
    resolveSetting(key, scope.context),
  ]);

  const fields = kitchenOnly ? definition.fields.filter((field) => field.kitchenEditable) : definition.fields;
  const visible = new Set(fields.map((field) => field.key));

  // Rebuild each version's change set in effective order (legacy snapshots are diffed).
  let state = null;
  const described = [];
  for (const version of [...versions].sort(byEffectiveOrder)) {
    const changes = versionChanges(version, state);
    state = version.patch ? applyPatch(state || {}, version.patch) : { ...(version.values || {}) };
    const platformAuthor = kitchenOnly && !isKitchenRole(version.createdBy?.role);
    described.push({
      version: version.version,
      changes: kitchenOnly ? pick(changes, visible) : changes,
      effectiveFrom: version.effectiveFrom,
      reason: platformAuthor ? null : version.reason,
      createdBy: platformAuthor ? { userId: null, name: "MealJi team", role: null } : version.createdBy,
      createdAt: version.createdAt,
      scheduled: new Date(version.effectiveFrom) > now,
    });
  }
  const relevant = kitchenOnly ? described.filter((item) => Object.keys(item.changes).length) : described;
  const stored = foldVersions(versions, now) || {};

  return {
    key,
    title: definition.title,
    description: definition.description,
    permission: definition.permission,
    scopes: definition.scopes,
    fields,
    defaults: kitchenOnly ? pick(defaultsOf(definition), visible) : defaultsOf(definition),
    scope: { type: scope.scopeType, id: scope.scopeId, label: scope.kitchen?.name || scope.scopeId || "All of MealJi" },
    stored: kitchenOnly ? pick(stored, visible) : stored,
    effective: kitchenOnly ? pick(effective.values, visible) : effective.values,
    sources: kitchenOnly ? pick(effective.sources, visible) : effective.sources,
    scheduled: relevant.filter((item) => item.scheduled).sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom)),
    history: relevant.sort((a, b) => b.version - a.version).slice(0, 30),
  };
}

function scopeSummary(definition, scope) {
  const where = scope.kitchen ? ` ${scope.kitchen.name}` : scope.scopeId ? ` ${scope.scopeId}` : "";
  return `${definition.title} (${scope.scopeType}${where})`;
}

/**
 * Saves a new version for one scope. `values` is a patch: only the fields
 * listed change; `null` removes the override. A future `effectiveFrom`
 * schedules the change; scheduled changes are independent, so an immediate edit
 * never pulls a future change forward. Money changes need a reason. The
 * version, its audit entry and its event are written together.
 */
export async function updateSetting(key, { scopeType = "global", scopeId = "", values, effectiveFrom = null, reason = null }, { req, kitchenOnly = false } = {}) {
  const definition = kitchenOnly ? await kitchenDefinition(key) : requireDefinition(key);
  const scope = await normalizeScope(definition, scopeType, scopeId);

  const errors = validatePatch(definition, values, { kitchenOnly });
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (moneyFieldsChanged(definition, values) && !trimmedReason) {
    throw new AppError(422, "Validation failed", [{ field: "reason", message: "A reason is required when changing money values" }]);
  }

  const now = new Date();
  const startsAt = effectiveFrom ? new Date(effectiveFrom) : now;
  if (Number.isNaN(startsAt.getTime())) throw new AppError(422, "effectiveFrom is not a valid date");
  if (startsAt.getTime() < now.getTime() - 60_000) throw new AppError(422, "effectiveFrom cannot be in the past");
  const scheduled = startsAt.getTime() > now.getTime();

  const versions = await scopeVersions(key, scope.scopeType, scope.scopeId);
  const before = foldVersions(versions, startsAt) || {};
  const after = applyPatch(before, values);
  const nextVersion = Math.max(0, ...versions.map((item) => item.version)) + 1;
  const user = req?.auth?.user;

  try {
    await withTransaction(async (session) => {
      await Setting.create([{
        key,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        version: nextVersion,
        patch: values,
        effectiveFrom: startsAt,
        reason: trimmedReason || null,
        createdBy: { userId: req?.auth?.userId || null, name: user?.name || null, role: req?.auth?.role || null },
        activationAnnounced: !scheduled,
      }], session ? { session } : {});
      await recordAudit(req, {
        action: "settings.updated",
        entityType: "setting",
        entityId: `${key}:${scope.scopeType}:${scope.scopeId || "global"}`,
        summary: `${scopeSummary(definition, scope)} v${nextVersion}${scheduled ? ` scheduled for ${startsAt.toISOString()}` : ""}`,
        before,
        after,
        reason: trimmedReason || null,
        kitchenId: scope.scopeType === "kitchen" ? scope.scopeId : null,
        session,
      });
      await publishEvent("settings.changed", {
        key,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        version: nextVersion,
        effectiveFrom: startsAt,
        changed: Object.keys(values),
      }, { session, aggregate: { type: "setting", id: key }, actor: req?.auth });
    });
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "Someone else changed this setting just now. Reload and try again.");
    throw err;
  }

  await invalidate(key, scope.scopeType, scope.scopeId);
  return getSettingDetail(key, { scopeType: scope.scopeType, scopeId: scope.scopeId, kitchenOnly });
}

// Cancels one version that has not taken effect yet. Other scheduled versions
// are untouched (each holds only its own change). Versions already in force are
// history: save a new version instead.
export async function cancelScheduledSetting(key, version, { scopeType = "global", scopeId = "", req, kitchenOnly = false } = {}) {
  const definition = requireDefinition(key);
  const scope = await normalizeScope(definition, scopeType, scopeId);
  const doc = await Setting.findOne({ key, scopeType: scope.scopeType, scopeId: scope.scopeId, version }).lean();
  if (!doc) throw new AppError(404, "Scheduled change not found");

  await withTransaction(async (session) => {
    const removed = await Setting.deleteOne(
      { _id: doc._id, effectiveFrom: { $gt: new Date() } },
      session ? { session } : {},
    );
    if (!removed.deletedCount) throw new AppError(409, "This change is already in effect");
    await recordAudit(req, {
      action: "settings.schedule_cancelled",
      entityType: "setting",
      entityId: `${key}:${scope.scopeType}:${scope.scopeId || "global"}`,
      summary: `Cancelled scheduled ${scopeSummary(definition, scope)} v${doc.version}`,
      before: { version: doc.version, effectiveFrom: doc.effectiveFrom, changes: doc.patch || doc.values },
      after: null,
      diff: false,
      kitchenId: scope.scopeType === "kitchen" ? scope.scopeId : null,
      session,
    });
    await publishEvent("settings.schedule_cancelled", {
      key,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      version: doc.version,
    }, { session, aggregate: { type: "setting", id: key }, actor: req?.auth });
  });

  await invalidate(key, scope.scopeType, scope.scopeId);
  return getSettingDetail(key, { scopeType: scope.scopeType, scopeId: scope.scopeId, kitchenOnly });
}

// Scheduled job: announces versions whose start time has arrived.
export async function activateDueSettings() {
  const due = await Setting.find({ activationAnnounced: false, effectiveFrom: { $lte: new Date() } }).limit(200).lean();
  let announced = 0;
  for (const doc of due) {
    const claimed = await withTransaction(async (session) => {
      const result = await Setting.updateOne(
        { _id: doc._id, activationAnnounced: false },
        { $set: { activationAnnounced: true } },
        session ? { session } : {},
      );
      if (!result.modifiedCount) return false;
      await publishEvent("settings.activated", {
        key: doc.key,
        scopeType: doc.scopeType,
        scopeId: doc.scopeId,
        version: doc.version,
        effectiveFrom: doc.effectiveFrom,
      }, { session, aggregate: { type: "setting", id: doc.key } });
      return true;
    });
    if (!claimed) continue;
    announced += 1;
    await invalidate(doc.key, doc.scopeType, doc.scopeId);
    logger.info({ key: doc.key, scopeType: doc.scopeType, scopeId: doc.scopeId, version: doc.version }, "Scheduled setting took effect");
  }
  return announced;
}

// What the customer app reads at start-up. Only fields marked `public`.
export async function getPublicAppConfig() {
  return { ...(await appConfigCache.get("app", buildPublicAppConfig)), serverTime: new Date().toISOString() };
}

async function buildPublicAppConfig() {
  const definition = requireDefinition("app");
  const { values } = await resolveSetting("app");
  const publicValues = Object.fromEntries(
    definition.fields.filter((field) => field.public).map((field) => [field.key, values[field.key]]),
  );
  // What the app's start, sign-in and onboarding screens need besides settings.
  const [{ Kitchen }, { OTP_LENGTH }, pricing] = await Promise.all([
    import("../kitchen/kitchen.model.js"),
    import("../../constants/otp.constants.js"),
    resolveSetting("pricing").catch(() => ({ values: {} })),
  ]);
  const cities = await Kitchen.distinct("city", { status: "active" }).catch(() => []);
  return {
    ...publicValues,
    deliveryEtaLabel: publicValues.deliveryPromiseLabel,
    pickupReadyMinutes: pricing.values.pickupReadyMinutes ?? 15,
    otpLength: OTP_LENGTH,
    otpResendSeconds: env.otpResendCooldownSec,
    countryCodes: ["+91"],
    servedCitiesCount: new Set(cities.map((city) => String(city).trim().toLowerCase()).filter(Boolean)).size,
    apiVersion: "v1",
    businessTimezone: BUSINESS_TIMEZONE,
    serverTime: new Date().toISOString(),
  };
}
