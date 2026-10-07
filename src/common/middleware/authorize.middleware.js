import { AppError } from "../errors/AppError.js";

export function authorize(permission) {
  return (req, res, next) => {
    const permissions = req.auth?.permissions || [];
    if (!permissions.includes(permission)) {
      return next(new AppError(403, "You do not have permission to perform this action"));
    }
    next();
  };
}
