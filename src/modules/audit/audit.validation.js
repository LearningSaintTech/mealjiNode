import { query } from "express-validator";

export const listAuditLogsValidation = [
  query("page").optional().isInt({ min: 1 }).withMessage("page must be a positive integer").toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100").toInt(),
  query("entityType").optional({ values: "falsy" }).trim().matches(/^[a-z_]{2,40}$/).withMessage("Invalid entity type"),
  query("entityId").optional({ values: "falsy" }).trim().isLength({ max: 80 }).withMessage("Invalid entity ID"),
  query("actorId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid actor ID"),
  query("kitchenId").optional({ values: "falsy" }).isMongoId().withMessage("Invalid kitchen ID"),
  query("action").optional({ values: "falsy" }).trim().matches(/^[a-z_.]{2,60}$/).withMessage("Invalid action"),
  query("from").optional({ values: "falsy" }).isISO8601().withMessage("from must be an ISO date"),
  query("to").optional({ values: "falsy" }).isISO8601().withMessage("to must be an ISO date"),
];
