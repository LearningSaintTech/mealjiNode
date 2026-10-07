import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { autocompletePlaces, geocodeAddress, placeDetails } from "../../infrastructure/googleMaps.service.js";
import { placeSearchLimiter } from "../../infrastructure/rateLimit.js";
import { serviceabilityAt, serviceabilityForPincode } from "../serviceability/serviceability.service.js";
import * as addresses from "./address.service.js";

const addressBody = (optional) => {
  const opt = (chain) => (optional ? chain.optional() : chain);
  return [
    body("label").optional().isIn(["home", "work", "other"]).withMessage("label must be home, work or other"),
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
    opt(body("latitude")).isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude").toFloat(),
    opt(body("longitude")).isFloat({ min: -180, max: 180 }).withMessage("Invalid longitude").toFloat(),
    body("isDefault").optional().isBoolean().toBoolean(),
  ];
};

// Mounted at /api/v1/users (alongside location).
export const addressRouter = Router();
addressRouter.use(authFor(["/me/addresses"], authMiddleware));
addressRouter.get("/me/addresses", asyncHandler(async (req, res) => ok(res, await addresses.listAddresses(req.auth.userId), "Addresses fetched.")));
addressRouter.post("/me/addresses", addressBody(false), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.createAddress(req.auth.userId, req.body), "Address saved.", 201)
)));
addressRouter.patch("/me/addresses/:id", idParam(), addressBody(true), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.updateAddress(req.auth.userId, req.params.id, req.body), "Address updated.")
)));
addressRouter.patch("/me/addresses/:id/default", idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.setDefaultAddress(req.auth.userId, req.params.id), "Default address set.")
)));
addressRouter.delete("/me/addresses/:id", idParam(), validate, asyncHandler(async (req, res) => (
  ok(res, await addresses.deleteAddress(req.auth.userId, req.params.id), "Address deleted.")
)));

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
  asyncHandler(async (req, res) => ok(res, await serviceabilityForPincode(req.params.pincode, { userId: req.auth.userId, geocode: geocodeAddress }), "Serviceability checked.")),
);
geoRouter.get(
  "/serviceability",
  query("latitude").isFloat({ min: -90, max: 90 }).toFloat(),
  query("longitude").isFloat({ min: -180, max: 180 }).toFloat(),
  validate,
  asyncHandler(async (req, res) => ok(res, await serviceabilityAt({ ...req.query, userId: req.auth.userId }), "Serviceability checked.")),
);
