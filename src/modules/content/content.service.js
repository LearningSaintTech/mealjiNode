import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { istParts } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { storeDel, storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { normalizeCity } from "../settings/settings.resolver.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { Banner, BANNER_PLACEMENTS, HomeSection, OnboardingSlide, SECTION_TYPES } from "./content.model.js";

const CACHE_KEY = "content:shared";
const CACHE_TTL = 120;

export async function invalidateContent() {
  await storeDel(CACHE_KEY).catch(() => {});
}

// Seed shown until the admin builds their own home: the layout the app has today.
const DEFAULT_SECTIONS = [
  { key: "hero", type: "banners", title: null, sortOrder: 0, config: { placement: "home_hero" } },
  { key: "categories", type: "categories", title: "What's on your mind?", sortOrder: 1, config: {} },
  { key: "usual", type: "usual", title: "Your usual", sortOrder: 2, config: { limit: 6 } },
  { key: "promo", type: "banners", title: null, sortOrder: 3, config: { placement: "home_promo" } },
  { key: "popular", type: "popular", title: "Popular today", sortOrder: 4, config: { limit: 8 } },
  { key: "combos", type: "combos", title: "Combos", sortOrder: 5, config: { placement: "home_combos" } },
  { key: "recommended", type: "recommended", title: "Picked for you", sortOrder: 5, config: { limit: 8 } },
  { key: "plus", type: "subscription_promo", title: "MealJi Plus", sortOrder: 6, config: {} },
  { key: "how_we_cook", type: "how_we_cook", title: "How we cook", sortOrder: 7, config: { placement: "home_how_we_cook" } },
];

export function toBanner(banner) {
  return {
    bannerId: String(banner._id),
    placement: banner.placement,
    eyebrow: banner.eyebrow ?? null,
    title: banner.title,
    highlight: banner.highlight ?? null,
    subtitle: banner.subtitle ?? null,
    imageUrl: banner.imageUrl ?? null,
    ctaLabel: banner.ctaLabel ?? null,
    deepLink: banner.deepLink ?? null,
    couponCode: banner.couponCode ?? null,
    startsAt: banner.startsAt ?? null,
    endsAt: banner.endsAt ?? null,
    sortOrder: banner.sortOrder || 0,
    isActive: banner.isActive !== false,
    cities: banner.cities || [],
    kitchenIds: (banner.kitchens || []).map(String),
    segmentId: banner.segment ? String(banner.segment) : null,
    impressions: banner.impressions || 0,
    clicks: banner.clicks || 0,
  };
}

function bannerData(input, partial) {
  const errors = [];
  const out = {};
  if (!partial || input.placement !== undefined) {
    if (!BANNER_PLACEMENTS.includes(input.placement)) errors.push({ field: "placement", message: `Placement: ${BANNER_PLACEMENTS.join(", ")}` });
    else out.placement = input.placement;
  }
  if (!partial || input.title !== undefined) {
    if (!input.title || String(input.title).trim().length > 120) errors.push({ field: "title", message: "Title is required (max 120)" });
    else out.title = String(input.title).trim();
  }
  for (const key of ["eyebrow", "highlight", "subtitle", "ctaLabel", "deepLink", "couponCode"]) {
    if (input[key] !== undefined) out[key] = input[key] ? String(input[key]).trim() : null;
  }
  if (input.imageUrl !== undefined) out.imageUrl = assertOwnFileUrl(input.imageUrl, "Banner image");
  for (const key of ["startsAt", "endsAt"]) {
    if (input[key] === undefined) continue;
    if (input[key] && Number.isNaN(new Date(input[key]).getTime())) errors.push({ field: key, message: "Invalid date" });
    else out[key] = input[key] ? new Date(input[key]) : null;
  }
  if (out.startsAt && out.endsAt && out.startsAt > out.endsAt) errors.push({ field: "endsAt", message: "Ends before it starts" });
  if (input.sortOrder !== undefined) out.sortOrder = Number(input.sortOrder) || 0;
  if (input.isActive !== undefined) out.isActive = Boolean(input.isActive);
  if (input.cities !== undefined) out.cities = (input.cities || []).map(normalizeCity).filter(Boolean);
  if (input.kitchenIds !== undefined) out.kitchens = (input.kitchenIds || []).map((id) => objectId(id, "kitchen ID"));
  if (input.segmentId !== undefined) out.segment = input.segmentId ? objectId(input.segmentId, "segment ID") : null;
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  return out;
}

export async function listBanners({ placement } = {}) {
  const filter = placement ? { placement } : {};
  return (await Banner.find(filter).sort({ placement: 1, sortOrder: 1, createdAt: -1 }).lean()).map(toBanner);
}

export async function saveBanner(bannerId, input) {
  const data = bannerData(input, Boolean(bannerId));
  let banner;
  if (bannerId) {
    banner = await Banner.findByIdAndUpdate(objectId(bannerId, "banner ID"), { $set: data }, { new: true });
    if (!banner) throw new AppError(404, "Banner not found");
  } else {
    banner = await Banner.create(data);
  }
  await invalidateContent();
  return toBanner(banner);
}

export async function deleteBanner(bannerId) {
  const banner = await Banner.findByIdAndDelete(objectId(bannerId, "banner ID"));
  if (!banner) throw new AppError(404, "Banner not found");
  await invalidateContent();
  return { bannerId, deleted: true, title: banner.title };
}

export async function trackBanner(bannerId, kind) {
  await Banner.updateOne({ _id: objectId(bannerId, "banner ID") }, { $inc: { [kind === "click" ? "clicks" : "impressions"]: 1 } });
  return { tracked: true };
}

// ---- onboarding slides

const toSlide = (slide) => ({ slideId: String(slide._id), title: slide.title, subtitle: slide.subtitle ?? null, imageUrl: slide.imageUrl ?? null, sortOrder: slide.sortOrder || 0, isActive: slide.isActive !== false });

export async function listSlides({ activeOnly = false } = {}) {
  return (await OnboardingSlide.find(activeOnly ? { isActive: true } : {}).sort({ sortOrder: 1 }).lean()).map(toSlide);
}

export async function saveSlide(slideId, input) {
  const data = {};
  if (input.title !== undefined) data.title = String(input.title || "").trim();
  if (!slideId && !data.title) throw new AppError(422, "Validation failed", [{ field: "title", message: "Title is required" }]);
  if (input.subtitle !== undefined) data.subtitle = input.subtitle ? String(input.subtitle).trim() : null;
  if (input.imageUrl !== undefined) data.imageUrl = assertOwnFileUrl(input.imageUrl, "Slide image");
  if (input.sortOrder !== undefined) data.sortOrder = Number(input.sortOrder) || 0;
  if (input.isActive !== undefined) data.isActive = Boolean(input.isActive);
  const slide = slideId
    ? await OnboardingSlide.findByIdAndUpdate(objectId(slideId, "slide ID"), { $set: data }, { new: true })
    : await OnboardingSlide.create(data);
  if (!slide) throw new AppError(404, "Slide not found");
  await invalidateContent();
  return toSlide(slide);
}

export async function deleteSlide(slideId) {
  const slide = await OnboardingSlide.findByIdAndDelete(objectId(slideId, "slide ID"));
  if (!slide) throw new AppError(404, "Slide not found");
  await invalidateContent();
  return { slideId, deleted: true };
}

// ---- home sections

const toSection = (section) => ({ key: section.key, type: section.type, title: section.title ?? null, subtitle: section.subtitle ?? null, sortOrder: section.sortOrder || 0, isActive: section.isActive !== false, config: section.config || {} });

export async function listSections() {
  const stored = await HomeSection.find().sort({ sortOrder: 1 }).lean();
  return stored.length ? stored.map(toSection) : DEFAULT_SECTIONS.map((section) => ({ ...section, subtitle: null, isActive: true }));
}

/** Replaces the whole home layout (ordered list of sections). */
export async function saveSections(sections) {
  if (!Array.isArray(sections) || sections.length > 30) throw new AppError(422, "sections must be a list (max 30)");
  const errors = [];
  const keys = new Set();
  sections.forEach((section, index) => {
    if (!/^[a-z0-9_]{2,40}$/.test(section?.key || "")) errors.push({ field: `sections[${index}].key`, message: "Key: 2-40 lowercase letters, digits or _" });
    if (keys.has(section?.key)) errors.push({ field: `sections[${index}].key`, message: "Duplicate key" });
    keys.add(section?.key);
    if (!SECTION_TYPES.includes(section?.type)) errors.push({ field: `sections[${index}].type`, message: `Type: ${SECTION_TYPES.join(", ")}` });
  });
  if (errors.length) throw new AppError(422, "Validation failed", errors);
  await HomeSection.deleteMany({});
  await HomeSection.insertMany(sections.map((section, index) => ({
    key: section.key,
    type: section.type,
    title: section.title || null,
    subtitle: section.subtitle || null,
    sortOrder: index,
    isActive: section.isActive !== false,
    config: section.config || {},
  })));
  await invalidateContent();
  return listSections();
}

// ---- customer read side

async function sharedContent() {
  const cached = await storeGetOptional(CACHE_KEY);
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const [banners, sections, slides] = await Promise.all([
    Banner.find({ isActive: true }).sort({ sortOrder: 1 }).lean(),
    listSections(),
    listSlides({ activeOnly: true }),
  ]);
  const shared = { banners: banners.map(toBanner), sections: sections.filter((section) => section.isActive), slides };
  await storeSet(CACHE_KEY, JSON.stringify(shared), CACHE_TTL).catch(() => {});
  return shared;
}

/** Banners live now for this kitchen/city (segment targeting is applied by the caller). */
export function bannersFor(all, { placement, kitchenId, city, segmentIds = [], now = new Date() }) {
  const cityKey = normalizeCity(city);
  return all.filter((banner) => (!placement || banner.placement === placement)
    && (!banner.startsAt || new Date(banner.startsAt) <= now)
    && (!banner.endsAt || new Date(banner.endsAt) > now)
    && (!banner.cities.length || banner.cities.includes(cityKey))
    && (!banner.kitchenIds.length || banner.kitchenIds.includes(String(kitchenId)))
    && (!banner.segmentId || segmentIds.includes(banner.segmentId)));
}

/**
 * Personal picks (Phase 5): dishes from the person's favourite categories they
 * have not tried, plus popular ones; veg-only respected. Empty for new customers.
 */
export async function recommendedFor(userId, kitchenId, limit = 8) {
  const catalog = await import("../catalog/catalog.service.js");
  const { UserStats } = await import("../engagement/traits.service.js");
  const { User } = await import("../user/user.model.js");
  const [menu, traits, user] = await Promise.all([catalog.kitchenMenu(kitchenId), UserStats.findOne({ user: userId }).lean(), User.findById(userId).select("preferences").lean()]);
  if (!traits?.deliveredOrdersCount) return [];
  const tried = new Set(traits.favDishIds || []);
  const favCategories = new Set(traits.favCategoryIds || []);
  const vegOnly = Boolean(user?.preferences?.vegOnly) || (traits.vegShare != null && traits.vegShare >= 0.95);
  const pool = menu.rawDishes.filter((dish) => catalog.isOrderable(dish) && (!vegOnly || dish.isVeg !== false));
  const scored = pool.map((dish) => ({
    dish,
    score: (favCategories.has(String(dish.category)) ? 3 : 0) + (tried.has(String(dish._id)) ? -2 : 1) + (dish.isBestseller ? 1 : 0) + Math.min(2, (dish.orderCount || 0) / 50) + (dish.ratingAvg || 0) / 5,
  }));
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((row) => catalog.toDish(row.dish));
}

export async function onboardingSlides() {
  return (await sharedContent()).slides;
}

function greeting(name, now = new Date()) {
  const hour = istParts(now).hour;
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return name && name !== "User" ? `${part}, ${name.split(" ")[0]}` : part;
}

async function safely(label, work, fallback = null) {
  try {
    return await work();
  } catch (err) {
    logger.warn({ err: err.message, part: label }, "Home section failed");
    return fallback;
  }
}

/**
 * GET /home: one call for the home screen. Shared content is cached; the
 * personal parts (greeting, your usual, cart, unread count, subscription) are
 * fetched in parallel, and a failing part never fails the whole screen.
 */
export async function homeFor(user, { latitude = null, longitude = null } = {}) {
  const { resolveCustomerKitchen, serviceabilityAt } = await import("../serviceability/serviceability.service.js");
  const catalog = await import("../catalog/catalog.service.js");
  const shared = await sharedContent();
  const userId = String(user._id);

  let serving = null;
  let serviceability = null;
  try {
    serving = await resolveCustomerKitchen({ latitude, longitude, userId });
    const point = latitude != null ? { latitude, longitude } : { latitude: serving.kitchen.latitude, longitude: serving.kitchen.longitude };
    serviceability = await serviceabilityAt({ ...point, userId });
  } catch (err) {
    if (err.statusCode !== 409 && err.statusCode !== 400) throw err;
    serviceability = { serviceable: false, message: err.message, kitchen: null };
  }
  const kitchenId = serving ? String(serving.kitchen._id) : null;
  const city = serving?.kitchen.city || user.currentLocation?.city || null;
  const segmentIds = await safely("segments", async () => (await import("../engagement/segment.service.js")).segmentIdsForUser(userId), []);

  const sections = await Promise.all(shared.sections.map(async (section) => {
    const base = { key: section.key, type: section.type, title: section.title, subtitle: section.subtitle };
    if (section.type === "banners" || section.type === "how_we_cook") {
      return { ...base, items: bannersFor(shared.banners, { placement: section.config.placement || "home_promo", kitchenId, city, segmentIds }) };
    }
    if (!kitchenId) return null;
    if (section.type === "categories") return { ...base, items: await safely("categories", () => catalog.customerCategories(kitchenId), []) };
    if (section.type === "popular") return { ...base, items: await safely("popular", () => catalog.popularDishes(kitchenId, section.config.limit || 8), []) };
    if (section.type === "combos") {
      return {
        ...base,
        banner: bannersFor(shared.banners, { placement: "home_combos", kitchenId, city, segmentIds })[0] || null,
        items: await safely("combos", () => catalog.customerCombos(kitchenId), []),
      };
    }
    if (section.type === "usual" || section.type === "reorder") {
      const items = await safely("usual", async () => (await import("../order/order.service.js")).usualDishes(userId, kitchenId, section.config.limit || 6), []);
      return items.length ? { ...base, items } : null;
    }
    if (section.type === "recommended") {
      const items = await safely("recommended", () => recommendedFor(userId, kitchenId, section.config.limit || 8), []);
      return items.length ? { ...base, items } : null;
    }
    if (section.type === "subscription_promo") {
      const plans = await safely("plans", async () => (await import("../subscription/plan.service.js")).plansForKitchen(kitchenId, { limit: 3 }), []);
      return plans.length ? { ...base, items: plans } : null;
    }
    if (section.type === "features") return { ...base, items: section.config.items || [] };
    return null;
  }));

  const [cart, unreadNotifications, subscription] = await Promise.all([
    safely("cart", async () => (await import("../cart/cart.service.js")).cartSummary(userId), null),
    safely("unread", async () => (await import("../notification/notification.service.js")).unreadCount(userId), 0),
    safely("subscription", async () => (await import("../subscription/subscription.service.js")).subscriptionCard(userId), null),
  ]);

  return {
    greeting: greeting(user.name),
    vegOnly: Boolean(user.preferences?.vegOnly),
    serviceability,
    kitchen: serviceability?.kitchen || null,
    sections: sections.filter(Boolean),
    cart,
    unreadNotifications,
    subscription,
  };
}
