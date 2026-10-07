import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { has, idParam, ok, ownKitchen, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { getReport } from "./report.registry.js";
import * as reports from "./report.service.js";

const filterQuery = [
  query("from").optional().isISO8601({ strict: true }),
  query("to").optional().isISO8601({ strict: true }),
  query("kitchenId").optional({ values: "falsy" }).isMongoId(),
  query("status").optional().isString().isLength({ max: 30 }),
  query("planCode").optional().isString().matches(/^[A-Za-z0-9_]{0,30}$/),
  query("channel").optional({ values: "falsy" }).isIn(["push", "inapp", "whatsapp", "sms", "email"]),
];
const anyReportAccess = (req, res, next) => (["reports.read", "reports.finance", "audit.read", "users.read"].some((key) => has(req, key)) ? next() : next(new AppError(403, "You do not have permission to perform this action")));

export const adminReportRouter = Router();
adminReportRouter.use(authMiddleware);

adminReportRouter.get("/reports", anyReportAccess, asyncHandler(async (req, res) => ok(res, reports.availableReports(req.auth.permissions), "Reports fetched.")));
adminReportRouter.get("/reports/exports", anyReportAccess, pageQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit, skip } = paging(req.query);
  const filter = has(req, "reports.export") ? {} : { "requestedBy.userId": req.auth.userId };
  const [items, total] = await Promise.all([reports.ReportJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), reports.ReportJob.countDocuments(filter)]);
  return ok(res, { items: items.map(reports.toJob), page, limit, total }, "Exports fetched.");
}));
adminReportRouter.get("/reports/exports/:id/download", anyReportAccess, idParam(), validate, asyncHandler(async (req, res) => {
  const { job, content } = await reports.readExport(req.params.id);
  const report = getReport(job.reportKey);
  if (!report || !(req.auth.permissions.includes(report.permission) || (report.permission === "reports.read" && has(req, "reports.finance")))) throw new AppError(403, "You do not have access to this report");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${job.fileKey}"`);
  return res.send(content);
}));

adminReportRouter.get("/reports/schedules", authorize("reports.schedule"), asyncHandler(async (req, res) => {
  const items = await reports.ReportSchedule.find().sort({ createdAt: -1 }).lean();
  return ok(res, items.map((item) => ({ ...item, scheduleId: String(item._id) })), "Schedules fetched.");
}));
const scheduleBody = [
  body("reportKey").isString().custom((value) => {
    if (!getReport(value)) throw new Error("Unknown report");
    return true;
  }),
  body("name").isString().trim().isLength({ min: 2, max: 80 }),
  body("frequency").isIn(["daily", "weekly", "monthly"]),
  body("time").matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body("weekday").optional().isInt({ min: 0, max: 6 }).toInt(),
  body("dayOfMonth").optional().isInt({ min: 1, max: 28 }).toInt(),
  body("rangeDays").optional().isInt({ min: 1, max: 92 }).toInt(),
  body("recipients").isArray({ min: 1, max: 20 }),
  body("recipients.*").isEmail(),
  body("isActive").optional().isBoolean(),
];
adminReportRouter.post("/reports/schedules", authorize("reports.schedule"), scheduleBody, validate, asyncHandler(async (req, res) => {
  const schedule = new reports.ReportSchedule({ ...req.body, filters: req.body.filters || {}, createdBy: { userId: req.auth.userId, name: req.auth.user?.name } });
  schedule.nextRunAt = reports.nextRunAt(schedule);
  await schedule.save();
  await recordAudit(req, { action: "report.scheduled", entityType: "report_schedule", entityId: String(schedule._id), summary: `Scheduled ${schedule.name} (${schedule.frequency} ${schedule.time}) to ${schedule.recipients.length} recipient(s)`, diff: false });
  return ok(res, { ...schedule.toObject(), scheduleId: String(schedule._id) }, "Schedule created.", 201);
}));
adminReportRouter.patch("/reports/schedules/:id", authorize("reports.schedule"), idParam(), validate, asyncHandler(async (req, res) => {
  const schedule = await reports.ReportSchedule.findById(req.params.id);
  if (!schedule) throw new AppError(404, "Schedule not found");
  for (const key of ["name", "frequency", "time", "weekday", "dayOfMonth", "rangeDays", "recipients", "isActive", "filters"]) if (req.body[key] !== undefined) schedule[key] = req.body[key];
  schedule.nextRunAt = reports.nextRunAt(schedule);
  await schedule.save();
  return ok(res, { ...schedule.toObject(), scheduleId: String(schedule._id) }, "Schedule updated.");
}));
adminReportRouter.delete("/reports/schedules/:id", authorize("reports.schedule"), idParam(), validate, asyncHandler(async (req, res) => {
  await reports.ReportSchedule.deleteOne({ _id: req.params.id });
  return ok(res, { deleted: true }, "Schedule deleted.");
}));

adminReportRouter.get("/reports/:key", anyReportAccess, param("key").matches(/^[a-z_]{3,60}$/), pageQuery, filterQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query, { defaultLimit: 50 });
  return ok(res, await reports.runReport(req.params.key, req.query, { permissions: req.auth.permissions, page, limit }), "Report.");
}));
adminReportRouter.post("/reports/:key/exports", authorize("reports.export"), param("key").matches(/^[a-z_]{3,60}$/), body("filters").optional().isObject(), validate, asyncHandler(async (req, res) => {
  const data = await reports.createExport(req.params.key, req.body.filters || {}, { permissions: req.auth.permissions, actor: { userId: req.auth.userId, name: req.auth.user?.name } });
  await recordAudit(req, { action: "report.exported", entityType: "report", entityId: req.params.key, summary: `Exported ${req.params.key} (${data.filters.from} to ${data.filters.to})`, diff: false });
  return ok(res, data, "Export started.", 202);
}));

// Kitchen console: own kitchen only, kitchen-scoped reports.
export const kitchenReportRouter = Router();
kitchenReportRouter.use(authMiddleware, authorize("kitchen.reports"), ownKitchen);
kitchenReportRouter.get("/", asyncHandler(async (req, res) => ok(res, reports.availableReports(req.auth.permissions, { kitchen: true }), "Reports fetched.")));
kitchenReportRouter.get("/:key", param("key").matches(/^[a-z_]{3,60}$/), pageQuery, filterQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query, { defaultLimit: 50 });
  return ok(res, await reports.runReport(req.params.key, req.query, { kitchenId: req.kitchenId, page, limit }), "Report.");
}));
kitchenReportRouter.get("/:key/csv", param("key").matches(/^[a-z_]{3,60}$/), filterQuery, validate, asyncHandler(async (req, res) => {
  const report = getReport(req.params.key);
  if (!report?.kitchenScoped) throw new AppError(404, "Report not found");
  const { csv } = await reports.buildCsv(report, reports.resolveFilters(report, req.query, { kitchenId: req.kitchenId }));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${report.key}.csv"`);
  return res.send(csv);
}));
