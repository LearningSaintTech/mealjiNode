// Code-registered report definitions. Each module adds its reports with
// registerReport(); the engine handles paging, CSV export, kitchen scoping,
// schedules and auditing. A report's run(filters, { page, limit, all }) returns
// { rows, total, totals? }; rows are flat objects keyed by column key.

const reports = new Map();

/**
 * definition = {
 *   key, title, category, description, permission ("reports.read" | "reports.finance"),
 *   filters: ["dateRange", "kitchenId", "status", ...], maxRangeDays,
 *   columns: [{ key, label, type: "text"|"number"|"money"|"date"|"datetime"|"percent" }],
 *   kitchenScoped: true when kitchen admins may run it for their own kitchen,
 *   run: async (filters, paging) => ({ rows, total, totals })
 * }
 */
export function registerReport(definition) {
  reports.set(definition.key, { maxRangeDays: 92, kitchenScoped: false, filters: ["dateRange"], ...definition });
}

export function getReport(key) {
  return reports.get(key) || null;
}

export function listReports() {
  return [...reports.values()].map(({ run, ...meta }) => meta);
}
