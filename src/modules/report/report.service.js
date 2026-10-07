import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { addIstDays, istDateKey, istDateTime } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { LOCAL_DIR } from "../upload/upload.service.js";
import { getReport, listReports } from "./report.registry.js";
import "./reports.core.js";
import "../subscription/reports.subscription.js";
import "../rewards/reports.loyalty.js";
import "../search/search.routes.js";
import "../support/reports.support.js";
import "../engagement/reports.engagement.js";

// ------------------------------------------------------------------ models

const reportJobSchema = new mongoose.Schema(
  {
    reportKey: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    format: { type: String, enum: ["csv"], default: "csv" },
    status: { type: String, enum: ["queued", "running", "done", "failed"], default: "queued" },
    rows: { type: Number, default: 0 },
    fileKey: { type: String, default: null },
    error: { type: String, default: null },
    requestedBy: { userId: String, name: String },
    schedule: { type: mongoose.Schema.Types.ObjectId, ref: "ReportSchedule", default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
reportJobSchema.index({ createdAt: -1 });
export const ReportJob = mongoose.models.ReportJob || mongoose.model("ReportJob", reportJobSchema);

// Scheduled exports emailed on a cron (Phase 4 scheduler).
const reportScheduleSchema = new mongoose.Schema(
  {
    reportKey: { type: String, required: true },
    name: { type: String, required: true, maxlength: 80 },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} }, // rangeDays instead of fixed dates
    rangeDays: { type: Number, default: 1 },
    frequency: { type: String, enum: ["daily", "weekly", "monthly"], default: "daily" },
    time: { type: String, default: "08:00" }, // IST
    weekday: { type: Number, default: 1 },
    dayOfMonth: { type: Number, default: 1 },
    recipients: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    lastRunAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null },
    createdBy: { userId: String, name: String },
  },
  { timestamps: true },
);
export const ReportSchedule = mongoose.models.ReportSchedule || mongoose.model("ReportSchedule", reportScheduleSchema);

// ------------------------------------------------------------------ running

function hasPermission(permissions, report) {
  return permissions.includes(report.permission) || (report.permission === "reports.read" && permissions.includes("reports.finance"));
}

/** Lists the reports this person may run (kitchen users: their kitchen-scoped ones). */
export function availableReports(permissions, { kitchen = false } = {}) {
  return listReports().filter((report) => (kitchen ? report.kitchenScoped : hasPermission(permissions, report)));
}

export function resolveFilters(report, query, { kitchenId = null } = {}) {
  const to = query.to || istDateKey();
  const from = query.from || addIstDays(to, -6);
  const fromDate = istDateTime(from, "00:00");
  const toDate = new Date(istDateTime(addIstDays(to, 1), "00:00").getTime() - 1);
  const days = Math.round((toDate - fromDate) / 86_400_000);
  if (days < 0) throw new AppError(422, "The start date is after the end date");
  if (report.filters.includes("dateRange") && days > report.maxRangeDays) throw new AppError(422, `This report covers at most ${report.maxRangeDays} days`);
  return {
    from: fromDate,
    to: toDate,
    fromKey: from,
    toKey: to,
    kitchenId: kitchenId || (report.filters.includes("kitchenId") ? query.kitchenId || null : null),
    status: query.status || null,
    planCode: query.planCode || null,
    channel: query.channel || null,
    campaignId: query.campaignId || null,
  };
}

export async function runReport(key, query, { permissions = [], kitchenId = null, page = 1, limit = 50 }) {
  const report = getReport(key);
  if (!report) throw new AppError(404, "Report not found");
  if (kitchenId ? !report.kitchenScoped : !hasPermission(permissions, report)) throw new AppError(403, "You do not have access to this report");
  const filters = resolveFilters(report, query, { kitchenId });
  const result = await report.run(filters, { skip: (page - 1) * limit, limit, all: false });
  const { run, ...meta } = report;
  return { report: meta, filters: { from: filters.fromKey, to: filters.toKey, kitchenId: filters.kitchenId, status: filters.status }, rows: result.rows, totals: result.totals || null, page, limit, total: result.total };
}

function csvCell(value, type) {
  if (value == null) return "";
  let text = value;
  if (type === "money") text = (Number(value) / 100).toFixed(2);
  else if (type === "percent") text = `${(Number(value) * 100).toFixed(1)}%`;
  else if (type === "datetime" && value) text = new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  else if (type === "date" && value) text = istDateKey(new Date(value));
  text = String(text);
  // Defuse spreadsheet formulas and quote when needed.
  if (/^[=+\-@]/.test(text) && type === "text") text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function buildCsv(report, filters) {
  const result = await report.run(filters, { skip: 0, limit: 0, all: true });
  const header = report.columns.map((column) => csvCell(column.label, "text")).join(",");
  const lines = result.rows.map((row) => report.columns.map((column) => csvCell(row[column.key], column.type)).join(","));
  return { csv: `﻿${[header, ...lines].join("\n")}`, rows: result.rows.length };
}

const REPORTS_DIR = path.join(LOCAL_DIR, "..", "report-exports");

/** Runs an export job: writes the CSV to private storage. */
export async function runExportJob(jobId) {
  const job = await ReportJob.findOneAndUpdate({ _id: jobId, status: "queued" }, { $set: { status: "running" } }, { new: true });
  if (!job) return null;
  try {
    const report = getReport(job.reportKey);
    const filters = { ...job.filters, from: new Date(job.filters.from), to: new Date(job.filters.to) };
    const { csv, rows } = await buildCsv(report, filters);
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const fileKey = `${job.reportKey}-${job.filters.fromKey}-${job.filters.toKey}-${String(job._id).slice(-6)}.csv`;
    await fs.writeFile(path.join(REPORTS_DIR, fileKey), csv, "utf8");
    job.status = "done";
    job.rows = rows;
    job.fileKey = fileKey;
    job.finishedAt = new Date();
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    logger.error({ err: err.message, jobId: String(job._id) }, "Report export failed");
  }
  await job.save();
  return job;
}

export async function createExport(key, query, { permissions, kitchenId = null, actor }) {
  const report = getReport(key);
  if (!report) throw new AppError(404, "Report not found");
  if (kitchenId ? !report.kitchenScoped : !hasPermission(permissions, report)) throw new AppError(403, "You do not have access to this report");
  const filters = resolveFilters(report, query, { kitchenId });
  const job = await ReportJob.create({ reportKey: key, filters, requestedBy: actor });
  // Small exports finish inline; the job model keeps big ones out of the request in production workers.
  setImmediate(() => runExportJob(job._id).catch(() => {}));
  return toJob(job);
}

export function toJob(job) {
  return {
    jobId: String(job._id),
    reportKey: job.reportKey,
    status: job.status,
    rows: job.rows,
    error: job.error,
    filters: { from: job.filters?.fromKey, to: job.filters?.toKey, kitchenId: job.filters?.kitchenId || null },
    downloadPath: job.status === "done" ? `/api/v1/admin/reports/exports/${job._id}/download` : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

export async function readExport(jobId) {
  const job = await ReportJob.findById(jobId).lean();
  if (!job || job.status !== "done") throw new AppError(404, "Export not ready");
  return { job, content: await fs.readFile(path.join(REPORTS_DIR, job.fileKey)) };
}

// ------------------------------------------------------------------ schedules

export function nextRunAt(schedule, after = new Date()) {
  let dateKey = istDateKey(after);
  for (let i = 0; i < 400; i += 1) {
    const at = istDateTime(dateKey, schedule.time || "08:00");
    const weekday = new Date(at.getTime() + 330 * 60_000).getUTCDay();
    const day = Number(dateKey.slice(8, 10));
    const matches = schedule.frequency === "daily"
      || (schedule.frequency === "weekly" && weekday === schedule.weekday)
      || (schedule.frequency === "monthly" && day === schedule.dayOfMonth);
    if (matches && at > after) return at;
    dateKey = addIstDays(dateKey, 1);
  }
  return null;
}

/** Every 5 minutes: runs due schedules and emails the CSV link to recipients. */
export async function runDueSchedules() {
  const due = await ReportSchedule.find({ isActive: true, nextRunAt: { $lte: new Date() } }).limit(20);
  for (const schedule of due) {
    const report = getReport(schedule.reportKey);
    schedule.lastRunAt = new Date();
    schedule.nextRunAt = nextRunAt(schedule);
    await schedule.save();
    if (!report) continue;
    const to = addIstDays(istDateKey(), -1);
    const filters = resolveFilters(report, { ...schedule.filters, from: addIstDays(to, -(schedule.rangeDays - 1)), to });
    const job = await ReportJob.create({ reportKey: report.key, filters, schedule: schedule._id, requestedBy: { userId: null, name: `Schedule: ${schedule.name}` } });
    const done = await runExportJob(job._id);
    if (done?.status !== "done") continue;
    const { sendEmail } = await import("../notification/channels.js");
    const { csv } = await buildCsv(report, filters);
    for (const recipient of schedule.recipients) {
      await sendEmail({
        to: recipient,
        subject: `${report.title}: ${filters.fromKey}${filters.fromKey !== filters.toKey ? ` to ${filters.toKey}` : ""}`,
        html: `<p>${report.title} (${done.rows} rows) is attached below as CSV text.</p><pre style="font-size:11px">${csv.slice(0, 200_000).replace(/</g, "&lt;")}</pre>`,
        text: csv.slice(0, 200_000),
      }).catch(() => {});
    }
  }
  return due.length;
}
