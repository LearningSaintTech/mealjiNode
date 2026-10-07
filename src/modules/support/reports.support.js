import { registerReport } from "../report/report.registry.js";
import { SupportTicket } from "./support.model.js";

registerReport({
  key: "tickets",
  title: "Support tickets",
  category: "Support",
  description: "Tickets by category with first response, resolution time, SLA breaches and CSAT.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "category", label: "Category", type: "text" },
    { key: "tickets", label: "Tickets", type: "number" },
    { key: "open", label: "Open", type: "number" },
    { key: "firstResponseHours", label: "First response (h)", type: "number" },
    { key: "resolutionHours", label: "Resolution (h)", type: "number" },
    { key: "breachRate", label: "SLA breached", type: "percent" },
    { key: "csat", label: "CSAT", type: "number" },
  ],
  async run(filters, paging) {
    const hours = (from, to) => ({ $avg: { $cond: [{ $and: [`$${from}`, `$${to}`] }, { $divide: [{ $subtract: [`$${to}`, `$${from}`] }, 3_600_000] }, null] } });
    const [result] = await SupportTicket.aggregate([
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      {
        $group: {
          _id: "$category",
          tickets: { $sum: 1 },
          open: { $sum: { $cond: [{ $in: ["$status", ["open", "in_progress", "pending_customer"]] }, 1, 0] } },
          first: hours("createdAt", "firstResponseAt"),
          resolved: hours("createdAt", "resolvedAt"),
          breached: { $sum: { $cond: ["$slaBreached", 1, 0] } },
          csat: { $avg: "$csat.rating" },
        },
      },
      { $project: { _id: 0, category: "$_id", tickets: 1, open: 1, firstResponseHours: { $round: ["$first", 1] }, resolutionHours: { $round: ["$resolved", 1] }, breachRate: { $round: [{ $divide: ["$breached", "$tickets"] }, 3] }, csat: { $round: ["$csat", 2] } } },
      { $sort: { tickets: -1 } },
      { $facet: { rows: paging.all ? [{ $skip: 0 }] : [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: "n" }] } },
    ]);
    return { rows: result.rows, total: result.total[0]?.n || 0 };
  },
});
