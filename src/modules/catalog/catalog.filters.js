// Query validators for the Filters sheet, shared by /menu, /dishes and /search
// so the same values are accepted (and refused with the same 422) everywhere.
import { query } from "express-validator";
import { DISH_SLOT_HOURS, DISH_SORTS, QUICK_FILTERS } from "./catalog.service.js";

const SLOT_VALUES = Object.keys(DISH_SLOT_HOURS);

/** Filters only (no search text): veg, quick, sort, cuisine, category, tag, slot, availability, price range. */
export const dishFilterValidators = [
  query("categoryId").optional({ values: "falsy" }).isString().isMongoId().withMessage("This category could not be found"),
  query("veg").optional().isBoolean().withMessage("Choose Veg or All"),
  query("availableOnly").optional().isBoolean().withMessage("Choose yes or no"),
  query("slot").optional().isIn(SLOT_VALUES).withMessage("Choose breakfast, lunch, snacks or dinner"),
  query("tag").optional().isString().isLength({ max: 40 }),
  query("quick").optional().isString().bail().custom((value) => String(value).split(",").every((item) => QUICK_FILTERS.some((chip) => chip.value === item.trim()))).withMessage("Choose a filter from the list"),
  query("cuisine").optional().isString().withMessage("Choose a cuisine from the list").bail().isLength({ max: 120 }).withMessage("Choose fewer cuisines"),
  query("minPricePaise").optional().isInt({ min: 0, max: 100_000_000 }).withMessage("Enter a valid price").toInt(),
  query("maxPricePaise").optional().isInt({ min: 0, max: 100_000_000 }).withMessage("Enter a valid price").toInt(),
  query("sort").optional().isIn(DISH_SORTS.map((item) => item.value)).withMessage("Choose a sort option from the list"),
];

export const pageValidators = [
  query("page").optional().isInt({ min: 1, max: 1000 }).withMessage("Page must be a number from 1 to 1000").toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("Show between 1 and 100 items").toInt(),
];
