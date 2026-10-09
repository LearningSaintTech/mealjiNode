import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { autocompletePlaces, geocodeAddress, placeDetails } from "../../infrastructure/googleMaps.service.js";
import { accountLimiter, placeSearchLimiter } from "../../infrastructure/rateLimit.js";
import { storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { serviceabilityAt, serviceabilityForPincode } from "../serviceability/serviceability.service.js";
import * as addresses from "./address.service.js";

const LABELS = { home: "home", work: "work", office: "work", other: "other" };

// Latitude/longitude are optional: the Add new address form has no map pin, so
// the server places the address from its text (then the pincode centre).
const addressBody = (optional) => {
  const opt = (chain) => (optional ? chain.optional() : chain);
  return [
    // The app's chips say Home / Office / Other; any other wording is kept as a custom label.
    body("label").optional({ values: "null" }).isString().customSanitizer((value, { req }) => {
      const word = String(value).trim();
      const known = LABELS[word.toLowerCase()];
      if (known) {
        // Switching to Home or Office drops an old custom wording.
        if (known !== "other" && req.body.customLabel === undefined) req.body.customLabel = null;
        return known;
      }
      if (word && !req.body.customLabel) req.body.customLabel = word.slice(0, 40);
      return "other";
    }),
    body("customLabel").optional({ values: "null" }).isString().isLength({ max: 40 }),
    body("recipientName").optional({ values: "null" }).isString().isLength({ max: 80 }),
    body("phone").optional({ values: "falsy" }).matches(/^[6-9]\d{9}$/).withMessage("Invalid phone number"),
    opt(body("houseFlat")).isString().trim().notEmpty().isLength({ max: 120 }).withMessage("House / flat is required"),
    body("street").optional({ values: "null" }).isString().isLength({ max: 160 }),
    body("locality").optional({ values: "null" }).isString().isLength({ max: 120 }),
    body("landmark").optional({ values: "null" }).isString().isLength({ max: 120 }),
    opt(body("city")).isString().trim().notEmpty().isLength({ max: 60 }).withMessage("City is required"),
    body("state").optional({ values: "null" }).isString().isLength({ max: 60 }),
    opt(body("pincode")).matches(/^\d{6}$/).withMessage("Pincode must be 6 digits"),
    body("latitude").optional({ values: "null" }).isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude").toFloat(),
    body("longitude").optional({ values: "null" }).isFloat({ min: -180, max: 180 }).withMessage("Invalid longitude").toFloat(),
    body("isDefault").optional().isBoolean().toBoolean(),
  ];
};

// Mounted at /api/v1/users (alongside location).
export const addressRouter = Router();
addressRouter.use(authFor(["/me/addresses"], authMiddleware));
addressRouter.get("/me/addresses", asyncHandler(async (req, res) => ok(res, await addresses.listAddresses(req.auth.userId), "Addresses fetched.")));
addressRouter.post("/me/addresses", addressBody(false), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.createAddress(req.auth.userId, req.body, { geocodePincode }), "Address saved.", 201)
)));
addressRouter.patch("/me/addresses/:id", idParam(), addressBody(true), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.updateAddress(req.auth.userId, req.params.id, req.body, { geocodePincode }), "Address updated.")
)));
addressRouter.patch("/me/addresses/:id/default", idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.setDefaultAddress(req.auth.userId, req.params.id), "Default address set.")
)));
addressRouter.delete("/me/addresses/:id", idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.deleteAddress(req.auth.userId, req.params.id), "Address deleted.")
)));

// Pincode centres change rarely: cache Google's answer for 30 days (also cuts the Maps bill).
async function geocodePincode(text) {
  const key = `geo:pin:${text}`;
  const cached = await storeGetOptional(key);
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const found = await geocodeAddress(text);
  // A country-wide match means Google did not know the pincode.
  const point = found && !found.vague ? { latitude: found.latitude, longitude: found.longitude } : null;
  if (point) await storeSet(key, JSON.stringify(point), 30 * 86_400).catch(() => {});
  return point;
}
const lookupLimiter = accountLimiter("serviceability", { limit: 60, windowSec: 60 });

// Mounted at /api/v1 – geo search and serviceability by pincode or point.
export const geoRouter = Router();
geoRouter.use(authFor(["/geo", "/serviceability"], authMiddleware));
geoRouter.get(
  "/geo/autocomplete",
  query("input").isString().trim().isLength({ min: 2, max: 120 }).withMessage("Type at least 2 characters"),
  query("latitude").optional().isFloat({ min: -90, max: 90 }).toFloat(),
  query("longitude").optional().isFloat({ min: -180, max: 180 }).toFloat(),
  query("sessionToken").optional().isString().isLength({ max: 80 }),
  validate,
  placeSearchLimiter,
  asyncHandler(async (req, res) => ok(res, await autocompletePlaces(req.query), "Suggestions fetched.")),
);
geoRouter.get(
  "/geo/place/:placeId",
  param("placeId").isString().isLength({ min: 3, max: 300 }),
  query("sessionToken").optional().isString().isLength({ max: 80 }),
  validate,
  placeSearchLimiter,
  asyncHandler(async (req, res) => {
    const place = await placeDetails({ placeId: req.params.placeId, sessionToken: req.query.sessionToken });
    const serviceability = place.latitude != null
      ? await serviceabilityAt({ latitude: place.latitude, longitude: place.longitude, userId: req.auth.userId, source: "address_search" })
      : null;
    return ok(res, { ...place, serviceability }, "Place fetched.");
  }),
);
geoRouter.get(
  "/serviceability/pincode/:pincode",
  param("pincode").matches(/^\d{6}$/).withMessage("Pincode must be 6 digits"),
  validate,
  lookupLimiter,
  asyncHandler(async (req, res) => ok(res, await serviceabilityForPincode(req.params.pincode, { userId: req.auth.userId, geocode: geocodePincode }), "Serviceability checked.")),
);
geoRouter.get(
  "/serviceability",
  query("latitude").isFloat({ min: -90, max: 90 }).toFloat(),
  query("longitude").isFloat({ min: -180, max: 180 }).toFloat(),
  validate,
  lookupLimiter,
  asyncHandler(async (req, res) => ok(res, await serviceabilityAt({ ...req.query, userId: req.auth.userId }), "Serviceability checked.")),
);
