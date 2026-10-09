import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { accountLimiter } from "../../infrastructure/rateLimit.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { toKitchen } from "../kitchen/kitchen.mapper.js";
import { resolveCustomerKitchen } from "../serviceability/serviceability.service.js";
import * as content from "./content.service.js";
import * as themes from "./theme.service.js";

// Public (no sign-in): onboarding is shown before login.
export const publicContentRouter = Router();
publicContentRouter.get("/onboarding/slides", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  return ok(res, await content.onboardingSlides(), "Slides fetched.");
}));

// Customer.
export const customerContentRouter = Router();
customerContentRouter.use(authFor(["/home", "/kitchen-about", "/banners"], authMiddleware));
customerContentRouter.get(
  "/home",
  query("latitude").optional().isFloat({ min: -90, max: 90 }).toFloat(),
  query("longitude").optional().isFloat({ min: -180, max: 180 }).toFloat()
    .custom((value, { req }) => (req.query.latitude == null) === (value == null)).withMessage("Send latitude and longitude together"),
  query("latitude").custom((value, { req }) => (value == null) === (req.query.longitude == null)).withMessage("Send latitude and longitude together"),
  query("veg").optional().isBoolean().withMessage("veg is true or false"),
  validate,
  accountLimiter("home", { limit: 120, windowSec: 60 }),
  asyncHandler(async (req, res) => ok(res, await content.homeFor(req.auth.user, req.query), "Home fetched.")),
);
customerContentRouter.get("/kitchen-about", query("kitchenId").optional({ values: "falsy" }).isMongoId(), validate, asyncHandler(async (req, res) => {
  const { kitchen } = await resolveCustomerKitchen({ kitchenId: req.query.kitchenId || null, userId: req.auth.userId });
  const view = toKitchen(kitchen);
  return ok(res, { kitchenId: view.kitchenId, name: view.name, area: view.area, city: view.city, ...view.about, ratingAvg: Math.round((view.ratingAvg || 0) * 10) / 10, ratingCount: view.ratingCount, opensAt: view.opensAt, closesAt: view.closesAt }, "About fetched.");
}));
customerContentRouter.post("/banners/:id/:event", idParam(), param("event").isIn(["impression", "click"]), validate, asyncHandler(async (req, res) => (
  ok(res, await content.trackBanner(req.params.id, req.params.event === "click" ? "click" : "impression", req.auth.userId), "Tracked.")
)));

// Admin.
export const adminContentRouter = Router();
adminContentRouter.use(authFor(["/banners", "/onboarding-slides", "/home-sections", "/home-themes"], authMiddleware));
const canEdit = authorize("content.manage");
const audit = (req, action, summary, extra = {}) => recordAudit(req, { action, entityType: "content", summary, diff: false, ...extra });

adminContentRouter.get("/banners", canEdit, query("placement").optional().isString(), validate, asyncHandler(async (req, res) => ok(res, await content.listBanners(req.query), "Banners fetched.")));
adminContentRouter.post("/banners", canEdit, asyncHandler(async (req, res) => {
  const data = await content.saveBanner(null, req.body);
  await audit(req, "content.banner_created", `Added banner ${data.title}`, { entityId: data.bannerId });
  return ok(res, data, "Banner added.", 201);
}));
adminContentRouter.patch("/banners/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => {
  const data = await content.saveBanner(req.params.id, req.body);
  await audit(req, "content.banner_updated", `Updated banner ${data.title}`, { entityId: data.bannerId });
  return ok(res, data, "Banner updated.");
}));
adminContentRouter.delete("/banners/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => {
  const data = await content.deleteBanner(req.params.id);
  await audit(req, "content.banner_deleted", `Deleted banner ${data.title}`, { entityId: data.bannerId });
  return ok(res, data, "Banner deleted.");
}));

adminContentRouter.get("/onboarding-slides", canEdit, asyncHandler(async (req, res) => ok(res, await content.listSlides(), "Slides fetched.")));
adminContentRouter.post("/onboarding-slides", canEdit, asyncHandler(async (req, res) => ok(res, await content.saveSlide(null, req.body), "Slide added.", 201)));
adminContentRouter.patch("/onboarding-slides/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => ok(res, await content.saveSlide(req.params.id, req.body), "Slide updated.")));
adminContentRouter.delete("/onboarding-slides/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => ok(res, await content.deleteSlide(req.params.id), "Slide deleted.")));

adminContentRouter.get("/home-sections", canEdit, asyncHandler(async (req, res) => ok(res, await content.listSections(), "Home layout fetched.")));
adminContentRouter.put("/home-sections", canEdit, body("sections").isArray(), validate, asyncHandler(async (req, res) => {
  const data = await content.saveSections(req.body.sections);
  await audit(req, "content.home_layout_changed", "Changed the home screen layout", { after: { sections: data.map((section) => section.key) } });
  return ok(res, data, "Home layout saved.");
}));

// Home header themes (default + dated seasonal looks).
adminContentRouter.get("/home-themes", canEdit, asyncHandler(async (req, res) => ok(res, await themes.listThemes(), "Themes fetched.")));
adminContentRouter.get("/home-themes/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => ok(res, await themes.getTheme(req.params.id), "Theme fetched.")));
adminContentRouter.post("/home-themes", canEdit, asyncHandler(async (req, res) => {
  const data = await themes.saveTheme(null, req.body);
  await audit(req, "content.theme_created", `Added home theme ${data.name}`, { entityId: data.themeId });
  return ok(res, data, "Theme added.", 201);
}));
adminContentRouter.patch("/home-themes/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => {
  const data = await themes.saveTheme(req.params.id, req.body);
  await audit(req, "content.theme_updated", `Updated home theme ${data.name}`, { entityId: data.themeId });
  return ok(res, data, "Theme updated.");
}));
adminContentRouter.delete("/home-themes/:id", canEdit, idParam(), validate, asyncHandler(async (req, res) => {
  const data = await themes.deleteTheme(req.params.id);
  await audit(req, "content.theme_deleted", `Deleted home theme ${data.name}`, { entityId: data.themeId });
  return ok(res, data, "Theme deleted.");
}));

// About the chef: platform edits any kitchen's page.
adminContentRouter.put("/kitchens/:id/about", authMiddleware, canEdit, idParam(), validate, asyncHandler(async (req, res) => {
  const kitchen = await Kitchen.findById(req.params.id);
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  const { assertOwnFileUrl } = await import("../upload/upload.service.js");
  const about = { ...(kitchen.about?.toObject?.() || kitchen.about || {}) };
  for (const key of ["chefName", "title", "story"]) if (req.body[key] !== undefined) about[key] = req.body[key] ? String(req.body[key]).slice(0, key === "story" ? 2000 : 120) : null;
  if (req.body.imageUrl !== undefined) about.imageUrl = assertOwnFileUrl(req.body.imageUrl);
  if (Array.isArray(req.body.gallery)) about.gallery = req.body.gallery.slice(0, 12).map((url) => assertOwnFileUrl(url));
  kitchen.about = about;
  await kitchen.save();
  await audit(req, "content.kitchen_about_changed", `Updated About page of ${kitchen.name}`, { entityId: String(kitchen._id), kitchenId: String(kitchen._id) });
  return ok(res, toKitchen(kitchen).about, "About page saved.");
}));
