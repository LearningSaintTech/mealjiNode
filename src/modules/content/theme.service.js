import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { cleanLink, stringArray } from "../../common/links.js";
import { normalizeCity } from "../settings/settings.resolver.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { HomeTheme } from "./content.model.js";

// Home header themes: the default look plus dated ones (Halloween, Diwali…).

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const HEADER_COLORS = ["statusBarColor", "textColor", "subTextColor"];
const PROMO_COLORS = ["titleColor", "subtitleColor", "ctaColor", "ctaTextColor"];
const PROMO_TEXT = { title: 60, badge: 20, subtitle: 120, ctaLabel: 30, couponCode: 30 };

/** What the app receives (no admin fields). */
export function toHeaderTheme(theme) {
  if (!theme) return null;
  const header = theme.header || {};
  const promo = theme.promo || {};
  return {
    themeId: String(theme._id),
    name: theme.name,
    endsAt: theme.endsAt ?? null,
    header: {
      backgroundColors: header.backgroundColors || [],
      gradientAngle: header.gradientAngle ?? 180,
      backgroundImageUrl: header.backgroundImageUrl ?? null,
      statusBarStyle: header.statusBarStyle || "light",
      statusBarColor: header.statusBarColor ?? null,
      textColor: header.textColor ?? null,
      subTextColor: header.subTextColor ?? null,
    },
    promo: promo.isVisible === false ? null : {
      title: promo.title ?? null,
      badge: promo.badge ?? null,
      subtitle: promo.subtitle ?? null,
      ctaLabel: promo.ctaLabel ?? null,
      deepLink: promo.deepLink ?? null,
      couponCode: promo.couponCode ?? null,
      leftImageUrl: promo.leftImageUrl ?? null,
      rightImageUrl: promo.rightImageUrl ?? null,
      backgroundColors: promo.backgroundColors || [],
      titleColor: promo.titleColor ?? null,
      subtitleColor: promo.subtitleColor ?? null,
      ctaColor: promo.ctaColor ?? null,
      ctaTextColor: promo.ctaTextColor ?? null,
    },
  };
}

export function toThemeAdmin(theme) {
  return {
    ...toHeaderTheme(theme),
    isDefault: Boolean(theme.isDefault),
    isActive: theme.isActive !== false,
    priority: theme.priority || 0,
    startsAt: theme.startsAt ?? null,
    endsAt: theme.endsAt ?? null,
    cities: theme.cities || [],
    promoVisible: theme.promo?.isVisible !== false,
    updatedAt: theme.updatedAt,
  };
}

/**
 * The theme live for a city at `now` (pure): the highest-priority dated theme
 * whose window contains `now`, else the default theme, else null. A theme
 * with no dates and not default is "always on" and also competes by priority.
 */
export function pickTheme(themes, { city = null, now = new Date() } = {}) {
  const at = now.getTime();
  const cityKey = city ? normalizeCity(city) : null;
  const live = themes.filter((theme) => {
    if (theme.isActive === false) return false;
    if (theme.cities?.length && (!cityKey || !theme.cities.includes(cityKey))) return false;
    if (theme.startsAt && new Date(theme.startsAt).getTime() > at) return false;
    if (theme.endsAt && new Date(theme.endsAt).getTime() <= at) return false;
    return true;
  });
  const special = live.filter((theme) => !theme.isDefault).sort((a, b) => (b.priority || 0) - (a.priority || 0)
    || new Date(b.startsAt || 0) - new Date(a.startsAt || 0));
  return special[0] || live.find((theme) => theme.isDefault) || null;
}

function colorList(value, field, errors, { max = 4 } = {}) {
  if (!Array.isArray(value) || value.length > max || value.some((color) => !HEX.test(String(color)))) {
    errors.push({ field, message: `${field}: up to ${max} colours as #RRGGBB or #RRGGBBAA` });
    return [];
  }
  return value.map((color) => String(color).toUpperCase());
}

function themeData(input, { partial }) {
  const errors = [];
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name || "").trim();
    if (!name || name.length > 60) errors.push({ field: "name", message: "Name is required (max 60)" });
    else out.name = name;
  }
  for (const key of ["isDefault", "isActive"]) if (input[key] !== undefined) out[key] = Boolean(input[key]);
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || input.priority < -100 || input.priority > 100) errors.push({ field: "priority", message: "Priority is -100 to 100" });
    else out.priority = input.priority;
  }
  for (const key of ["startsAt", "endsAt"]) {
    if (input[key] === undefined) continue;
    if (input[key] && Number.isNaN(new Date(input[key]).getTime())) errors.push({ field: key, message: "Invalid date" });
    else out[key] = input[key] ? new Date(input[key]) : null;
  }
  if (out.startsAt && out.endsAt && out.startsAt >= out.endsAt) errors.push({ field: "endsAt", message: "Ends before it starts" });
  if (input.cities !== undefined) out.cities = stringArray(input.cities || [], "cities", errors).map(normalizeCity).filter(Boolean);

  if (input.header !== undefined) {
    const header = input.header || {};
    if (header.backgroundColors !== undefined) out["header.backgroundColors"] = colorList(header.backgroundColors, "header.backgroundColors", errors);
    if (header.gradientAngle !== undefined) {
      if (!Number.isFinite(Number(header.gradientAngle)) || header.gradientAngle < 0 || header.gradientAngle > 360) errors.push({ field: "header.gradientAngle", message: "Angle is 0 to 360" });
      else out["header.gradientAngle"] = Number(header.gradientAngle);
    }
    if (header.backgroundImageUrl !== undefined) out["header.backgroundImageUrl"] = assertOwnFileUrl(header.backgroundImageUrl, "Header image");
    if (header.statusBarStyle !== undefined) {
      if (!["light", "dark"].includes(header.statusBarStyle)) errors.push({ field: "header.statusBarStyle", message: "light or dark" });
      else out["header.statusBarStyle"] = header.statusBarStyle;
    }
    for (const key of HEADER_COLORS) {
      if (header[key] === undefined) continue;
      if (header[key] && !HEX.test(header[key])) errors.push({ field: `header.${key}`, message: "Colour as #RRGGBB" });
      else out[`header.${key}`] = header[key] ? String(header[key]).toUpperCase() : null;
    }
  }
  if (input.promo !== undefined) {
    const promo = input.promo || {};
    if (promo.isVisible !== undefined) out["promo.isVisible"] = Boolean(promo.isVisible);
    for (const [key, max] of Object.entries(PROMO_TEXT)) {
      if (promo[key] === undefined) continue;
      const value = promo[key] == null ? null : String(promo[key]).trim();
      if (value && value.length > max) errors.push({ field: `promo.${key}`, message: `Up to ${max} characters` });
      else out[`promo.${key}`] = value || null;
    }
    if (promo.deepLink !== undefined) out["promo.deepLink"] = cleanLink(promo.deepLink, "promo.deepLink", errors);
    for (const key of ["leftImageUrl", "rightImageUrl"]) if (promo[key] !== undefined) out[`promo.${key}`] = assertOwnFileUrl(promo[key], "Promo image");
    if (promo.backgroundColors !== undefined) out["promo.backgroundColors"] = colorList(promo.backgroundColors, "promo.backgroundColors", errors);
    for (const key of PROMO_COLORS) {
      if (promo[key] === undefined) continue;
      if (promo[key] && !HEX.test(promo[key])) errors.push({ field: `promo.${key}`, message: "Colour as #RRGGBB" });
      else out[`promo.${key}`] = promo[key] ? String(promo[key]).toUpperCase() : null;
    }
  }
  if (!partial && !out["header.backgroundColors"]?.length && !out["header.backgroundImageUrl"]) {
    errors.push({ field: "header.backgroundColors", message: "Give background colours or a background image" });
  }
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  return out;
}

export async function listThemes() {
  const themes = await HomeTheme.find().sort({ isDefault: -1, startsAt: 1, createdAt: -1 }).lean();
  const live = pickTheme(themes, { now: new Date() });
  return themes.map((theme) => ({ ...toThemeAdmin(theme), isLiveNow: live ? String(live._id) === String(theme._id) : false }));
}

export async function getTheme(themeId) {
  const theme = await HomeTheme.findById(objectId(themeId, "theme ID")).lean();
  if (!theme) throw new AppError(404, "Theme not found");
  return toThemeAdmin(theme);
}

export async function saveTheme(themeId, input) {
  const data = themeData(input, { partial: Boolean(themeId) });
  let theme;
  if (themeId) {
    theme = await HomeTheme.findByIdAndUpdate(objectId(themeId, "theme ID"), { $set: data }, { new: true, runValidators: true });
    if (!theme) throw new AppError(404, "Theme not found");
  } else {
    const doc = {};
    for (const [path, value] of Object.entries(data)) {
      const [head, tail] = path.split(".");
      if (tail) doc[head] = { ...(doc[head] || {}), [tail]: value };
      else doc[head] = value;
    }
    theme = await HomeTheme.create(doc);
  }
  // Exactly one default.
  if (theme.isDefault) await HomeTheme.updateMany({ _id: { $ne: theme._id }, isDefault: true }, { $set: { isDefault: false } });
  const { invalidateContent } = await import("./content.service.js");
  await invalidateContent();
  return toThemeAdmin(theme.toObject());
}

export async function deleteTheme(themeId) {
  const theme = await HomeTheme.findById(objectId(themeId, "theme ID"));
  if (!theme) throw new AppError(404, "Theme not found");
  if (theme.isDefault) throw new AppError(409, "Make another theme the default before deleting this one");
  await theme.deleteOne();
  const { invalidateContent } = await import("./content.service.js");
  await invalidateContent();
  return { themeId, deleted: true, name: theme.name };
}
