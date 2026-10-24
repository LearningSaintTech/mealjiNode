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
    message = "This item could not be found";
    errors = [{ field: err.path, message: "This item could not be found" }];
  } else if (err.code === 11000) {
    statusCode = 409;
    const fields = Object.keys(err.keyPattern || err.keyValue || {});
    message = fields.includes("phoneNumber")
      ? "This phone number is already in use"
      : "A record with these details already exists";
    errors = null;
  } else if (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400)) {
    statusCode = 400;
    message = "The request could not be read. Please try again.";
    errors = null;
  } else if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Invalid or expired token";
    errors = null;
  }

  // Customers see `message`: for a list of field problems, the first one is the message.
  if (message === "Validation failed" && Array.isArray(errors) && errors[0]?.message) message = errors[0].message;

  if (statusCode >= 500) {
    req.log?.error({ err }, "Request failed");
  }

  // Server faults never leak details in production. An AppError for a dependency that is down or
  // refused (502/503/504) keeps its message: it was written for the user ("Couldn't connect the
  // call. Please try again."). Plain 500s (configuration, bugs) stay generic.
  const userFacing = err.isOperational && statusCode >= 502 && statusCode <= 504;
  if (statusCode >= 500 && env.isProd && !userFacing) {
    message = "Internal server error";
    errors = null;
  }

  res.status(statusCode).json({
    success: false,
    message,
    errors,
  });
}
