import { body, query } from "express-validator";

export const updateLocationValidation = [
  body("latitude")
    .isFloat({ min: -90, max: 90 })
    .withMessage("latitude must be between -90 and 90")
    .toFloat(),
  body("longitude")
    .isFloat({ min: -180, max: 180 })
    .withMessage("longitude must be between -180 and 180")
    .toFloat(),
];

export const serviceabilityValidation = [
  query("latitude").optional().isFloat({ min: -90, max: 90 }).withMessage("latitude must be between -90 and 90").toFloat(),
  query("longitude").optional().isFloat({ min: -180, max: 180 }).withMessage("longitude must be between -180 and 180").toFloat(),
  query("longitude").custom((value, { req }) => {
    const hasLatitude = req.query.latitude !== undefined && req.query.latitude !== "";
    const hasLongitude = value !== undefined && value !== "";
    if (hasLatitude !== hasLongitude) throw new Error("Latitude and longitude are both required");
    return true;
  }),
];
