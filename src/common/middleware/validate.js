import { validationResult } from "express-validator";
import { AppError } from "../errors/AppError.js";

export function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = result.array().map((item) => ({
    field: item.path,
    message: item.msg,
  }));
  next(new AppError(422, "Validation failed", errors));
}
