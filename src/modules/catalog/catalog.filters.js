// Query validators for the Filters sheet, shared by /menu, /dishes and /search
// so the same values are accepted (and refused with the same 422) everywhere.
import { query } from "express-validator";
import { DISH_SLOT_HOURS, DISH_SORTS, QUICK_FILTERS } from "./catalog.service.js";

const SLOT_VALUES = Object.keys(DISH_SLOT_HOURS);

/** Filters only (no search text): veg, quick, sort, cuisine, category, tag, slot, availability, price range. */
export const dishFilterValidators = [
  query("categoryId").optional({ values: "falsy" }).isMongoId().withMessage("categoryId is not valid"),
  query("veg").optional().isBoolean().withMessage("veg is true or false"),
  query("availableOnly").optional().isBoolean().withMessage("availableOnly is true or false"),
  query("slot").optional().isIn(SLOT_VALUES).withMessage(`slot: ${SLOT_VALUES.join(", ")}`),
  query("tag").optional().isString().isLength({ max: 40 }),
  query("quick").optional().isString().bail().custom((value) => String(value).split(",").every((item) => QUICK_FILTERS.some((chip) => chip.value === item.trim()))).withMessage(`quick: ${QUICK_FILTERS.map((item) => item.value).join(", ")}`),
  query("cuisine").optional().isString().withMessage("cuisine must be text").bail().isLength({ max: 120 }).withMessage("cuisine is too long"),
  query("minPricePaise").optional().isInt({ min: 0 }).withMessage("minPricePaise must be a whole number of paise").toInt(),
  query("maxPricePaise").optional().isInt({ min: 0 }).withMessage("maxPricePaise must be a whole number of paise").toInt(),
  query("sort").optional().isIn(DISH_SORTS.map((item) => item.value)).withMessage(`sort: ${DISH_SORTS.map((item) => item.value).join(", ")}`),
];

export const pageValidators = [
  query("page").optional().isInt({ min: 1, max: 1000 }).withMessage("page is not valid").toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit is 1 to 100").toInt(),
];
