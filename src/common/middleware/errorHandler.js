import { env } from "../../config/env.js";

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal server error";
  let errors = err.errors ?? null;

  if (err.name === "ValidationError" && !err.statusCode) {
    statusCode = 422;
    message = "Validation failed";
    errors = Object.values(err.errors || {}).map((item) => ({
      field: item.path,
      message: item.message,
    }));
  } else if (err.name === "CastError") {
    statusCode = 400;
    message = "Invalid identifier";
    errors = [{ field: err.path, message: "Invalid identifier" }];
  } else if (err.code === 11000) {
    statusCode = 409;
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    message = fields.includes("phoneNumber")
      ? "This phone number is already in use"
      : "A record with these details already exists";
    errors = null;
  } else if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400)) {
    statusCode = 400;
    message = "Invalid JSON body";
    errors = null;
  } else if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Invalid or expired token";
    errors = null;
  }

  if (statusCode >= 500) {
    req.log?.error({ err }, "Request failed");
  }

  if (statusCode >= 500 && env.isProd) {
    message = "Internal server error";
    errors = null;
  }

  res.status(statusCode).json({
    success: false,
    message,
    errors,
  });
}
