import { AppError } from "../errors/AppError.js";

export function notFound(req, res, next) {
  next(new AppError(404, "Route not found"));
}
