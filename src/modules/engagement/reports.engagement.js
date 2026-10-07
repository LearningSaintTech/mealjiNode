import mongoose from "mongoose";
import { UserConsent } from "../consent/consent.model.js";
import { MessageLog } from "../notification/notification.model.js";
import { Order } from "../order/order.model.js";
import { registerReport } from "../report/report.registry.js";
import { UserStats } from "./traits.service.js";

// Phase 4 reports: marketing, engagement, deeper sales and customer analysis.

const page = async (model, pipeline, paging) => {
  const [result] = await model.aggregate([...pipeline, { $facet: { rows: paging.all ? [{ $skip: 0 }] : [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: "n" }] } }]).allowDiskUse(true);
  return { rows: result.rows, total: result.total[0]?.n || 0 };
};
const counted = (status) => ({ $sum: { $cond: [{ $in: ["$status", status] }, 1, 0] } });
const has = (field) => ({ $sum: { $cond: [`$${field}`, 1, 0] } });

registerReport({
  key: "campaign_performance",
  title: "Campaign performance",
  category: "Marketing & engagement",
  description: "Per campaign, variant and channel: sent, delivered, opened, clicked, converted and revenue.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "campaign", label: "Campaign", type: "text" },
    { key: "variant", label: "Variant", type: "text" },
    { key: "channel", label: "Channel", type: "text" },
    { key: "targeted", label: "Targeted", type: "number" },
    { key: "suppressed", label: "Suppressed", type: "number" },
    { key: "sent", label: "Sent", type: "number" },
    { key: "opened", label: "Opened", type: "number" },
    { key: "clicked", label: "Clicked", type: "number" },
    { key: "converted", label: "Converted", type: "number" },
    { key: "revenuePaise", label: "Revenue", type: "money" },
  ],
  async run(filters, paging) {
    return page(MessageLog, [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to }, campaign: { $ne: null } } },
      { $group: { _id: { campaign: "$campaign", variant: "$variant", channel: "$channel" }, targeted: { $sum: 1 }, suppressed: counted(["suppressed"]), sent: counted(["sent", "delivered", "opened", "clicked"]), opened: has("openedAt"), clicked: has("clickedAt"), converted: has("convertedAt"), revenuePaise: { $sum: "$conversionValuePaise" } } },
      { $lookup: { from: "campaigns", localField: "_id.campaign", foreignField: "_id", as: "c" } },
      { $project: { _id: 0, campaign: { $first: "$c.name" }, variant: "$_id.variant", channel: "$_id.channel", targeted: 1, suppressed: 1, sent: 1, opened: 1, clicked: 1, converted: 1, revenuePaise: 1 } },
      { $sort: { campaign: 1, variant: 1 } },
    ], paging);
  },
});

registerReport({
  key: "journey_performance",
  title: "Journey performance",
  category: "Marketing & engagement",
  description: "Messages, conversions and revenue per journey.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "journey", label: "Journey", type: "text" },
    { key: "sent", label: "Sent", type: "number" },
    { key: "opened", label: "Opened", type: "number" },
    { key: "converted", label: "Converted", type: "number" },
    { key: "revenuePaise", label: "Revenue", type: "money" },
  ],
  async run(filters, paging) {
    return page(MessageLog, [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to }, journey: { $ne: null } } },
      { $group: { _id: "$journey", sent: counted(["sent", "delivered", "opened", "clicked"]), opened: has("openedAt"), converted: has("convertedAt"), revenuePaise: { $sum: "$conversionValuePaise" } } },
      { $lookup: { from: "journeys", localField: "_id", foreignField: "_id", as: "j" } },
      { $project: { _id: 0, journey: { $first: "$j.name" }, sent: 1, opened: 1, converted: 1, revenuePaise: 1 } },
    ], paging);
  },
});

registerReport({
  key: "channel_deliverability",
  title: "Channel deliverability",
  category: "Marketing & engagement",
  description: "Sent, delivered, failed and suppressed per channel and reason.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "channel", label: "Channel", type: "text" },
    { key: "category", label: "Type", type: "text" },
    { key: "sent", label: "Sent", type: "number" },
    { key: "delivered", label: "Delivered", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "suppressed", label: "Suppressed", type: "number" },
    { key: "topReason", label: "Main suppression reason", type: "text" },
  ],
  async run(filters, paging) {
    return page(MessageLog, [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      { $group: { _id: { channel: "$channel", category: "$category" }, sent: counted(["sent", "delivered", "opened", "clicked"]), delivered: has("deliveredAt"), failed: counted(["failed"]), suppressed: counted(["suppressed"]), reasons: { $push: "$suppressedReason" } } },
      { $project: { _id: 0, channel: "$_id.channel", category: "$_id.category", sent: 1, delivered: 1, failed: 1, suppressed: 1, topReason: { $first: { $filter: { input: "$reasons", cond: { $ne: ["$$this", null] } } } } } },
      { $sort: { channel: 1 } },
    ], paging);
  },
});

registerReport({
  key: "consent_register",
  title: "Consent register",
  category: "Marketing & engagement",
  description: "Opt-ins and opt-outs by channel over time (DPDP compliance).",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "date", label: "Date", type: "text" },
    { key: "channel", label: "Channel", type: "text" },
    { key: "granted", label: "Opt-ins", type: "number" },
    { key: "revoked", label: "Opt-outs", type: "number" },
    { key: "sources", label: "Sources", type: "text" },
  ],
  async run(filters, paging) {
    return page(UserConsent, [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, channel: "$channel" }, granted: counted(["granted"]), revoked: counted(["revoked"]), sources: { $addToSet: "$source" } } },
      { $project: { _id: 0, date: "$_id.date", channel: "$_id.channel", granted: 1, revoked: 1, sources: { $reduce: { input: "$sources", initialValue: "", in: { $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", ", "] }, "$$this"] } } } } },
      { $sort: { date: -1 } },
    ], paging);
  },
});

registerReport({
  key: "notification_log",
  title: "Notification log",
  category: "Marketing & engagement",
  description: "Every message sent, for support investigations.",
  permission: "messages.read",
  filters: ["dateRange", "channel", "status"],
  columns: [
    { key: "createdAt", label: "When", type: "datetime" },
    { key: "customer", label: "Customer", type: "text" },
    { key: "channel", label: "Channel", type: "text" },
    { key: "templateKey", label: "Template", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "title", label: "Title", type: "text" },
    { key: "reason", label: "Reason / error", type: "text" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to } };
    if (filters.channel) match.channel = filters.channel;
    if (filters.status) match.status = filters.status;
    return page(MessageLog, [
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "u" } },
      { $project: { _id: 0, createdAt: 1, customer: { $first: "$u.name" }, channel: 1, templateKey: 1, status: 1, title: "$rendered.title", reason: { $ifNull: ["$suppressedReason", "$error"] } } },
    ], paging);
  },
});

registerReport({
  key: "new_vs_returning",
  title: "New vs returning customers",
  category: "Customers",
  description: "Orders per day from first-time and returning customers.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "date", label: "Date", type: "text" },
    { key: "newCustomers", label: "First orders", type: "number" },
    { key: "returning", label: "Returning orders", type: "number" },
    { key: "newGmvPaise", label: "First-order GMV", type: "money" },
    { key: "returningGmvPaise", label: "Returning GMV", type: "money" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to }, status: { $nin: ["payment_pending", "payment_failed", "cancelled"] } };
    if (filters.kitchenId) match.kitchen = new mongoose.Types.ObjectId(String(filters.kitchenId));
    return page(Order, [
      { $match: match },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, newCustomers: { $sum: { $cond: ["$isFirstOrder", 1, 0] } }, returning: { $sum: { $cond: ["$isFirstOrder", 0, 1] } }, newGmvPaise: { $sum: { $cond: ["$isFirstOrder", "$bill.grandTotalPaise", 0] } }, returningGmvPaise: { $sum: { $cond: ["$isFirstOrder", 0, "$bill.grandTotalPaise"] } } } },
      { $project: { _id: 0, date: "$_id", newCustomers: 1, returning: 1, newGmvPaise: 1, returningGmvPaise: 1 } },
      { $sort: { date: -1 } },
    ], paging);
  },
});

registerReport({
  key: "sales_by_hour",
  title: "Sales by hour and weekday",
  category: "Sales",
  description: "Orders and GMV heat map by hour of day and weekday.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "weekday", label: "Weekday", type: "text" },
    { key: "hour", label: "Hour", type: "number" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "gmvPaise", label: "GMV", type: "money" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to }, status: { $nin: ["payment_pending", "payment_failed", "cancelled"] } };
    if (filters.kitchenId) match.kitchen = new mongoose.Types.ObjectId(String(filters.kitchenId));
    const days = ["", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const result = await page(Order, [
      { $match: match },
      { $group: { _id: { weekday: { $dayOfWeek: { date: "$createdAt", timezone: "Asia/Kolkata" } }, hour: { $hour: { date: "$createdAt", timezone: "Asia/Kolkata" } } }, orders: { $sum: 1 }, gmvPaise: { $sum: "$bill.grandTotalPaise" } } },
      { $project: { _id: 0, weekdayNo: "$_id.weekday", hour: "$_id.hour", orders: 1, gmvPaise: 1 } },
      { $sort: { weekdayNo: 1, hour: 1 } },
    ], paging);
    return { ...result, rows: result.rows.map((row) => ({ ...row, weekday: days[row.weekdayNo] })) };
  },
});

registerReport({
  key: "sales_by_city",
  title: "Sales by city and kitchen",
  category: "Sales",
  description: "Orders, GMV and new customers per city and kitchen.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "city", label: "City", type: "text" },
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "gmvPaise", label: "GMV", type: "money" },
    { key: "newCustomers", label: "New customers", type: "number" },
  ],
  async run(filters, paging) {
    return page(Order, [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to }, status: { $nin: ["payment_pending", "payment_failed", "cancelled"] } } },
      { $group: { _id: { city: "$city", kitchen: "$kitchenName" }, orders: { $sum: 1 }, gmvPaise: { $sum: "$bill.grandTotalPaise" }, newCustomers: { $sum: { $cond: ["$isFirstOrder", 1, 0] } } } },
      { $project: { _id: 0, city: "$_id.city", kitchen: "$_id.kitchen", orders: 1, gmvPaise: 1, newCustomers: 1 } },
      { $sort: { gmvPaise: -1 } },
    ], paging);
  },
});

registerReport({
  key: "rfm_segments",
  title: "RFM segments",
  category: "Customers",
  description: "Customers bucketed by recency, frequency and monetary value.",
  permission: "reports.read",
  filters: [],
  columns: [
    { key: "segment", label: "Segment", type: "text" },
    { key: "customers", label: "Customers", type: "number" },
    { key: "avgOrders", label: "Avg orders", type: "number" },
    { key: "avgLtvPaise", label: "Avg lifetime value", type: "money" },
    { key: "avgDaysSinceOrder", label: "Avg days since order", type: "number" },
  ],
  async run(filters, paging) {
    return page(UserStats, [
      { $match: { deliveredOrdersCount: { $gt: 0 } } },
      {
        $addFields: {
          segment: {
            $switch: {
              branches: [
                { case: { $and: [{ $lte: ["$daysSinceLastOrder", 14] }, { $gte: ["$deliveredOrdersCount", 5] }] }, then: "Champions" },
                { case: { $and: [{ $lte: ["$daysSinceLastOrder", 30] }, { $gte: ["$deliveredOrdersCount", 3] }] }, then: "Loyal" },
                { case: { $and: [{ $lte: ["$daysSinceLastOrder", 14] }, { $lt: ["$deliveredOrdersCount", 3] }] }, then: "New / promising" },
                { case: { $and: [{ $gt: ["$daysSinceLastOrder", 30] }, { $lte: ["$daysSinceLastOrder", 60] }] }, then: "Needs attention" },
                { case: { $gt: ["$daysSinceLastOrder", 60] }, then: "At risk / lost" },
              ],
              default: "Others",
            },
          },
        },
      },
      { $group: { _id: "$segment", customers: { $sum: 1 }, avgOrders: { $avg: "$deliveredOrdersCount" }, avgLtvPaise: { $avg: "$lifetimeValuePaise" }, avgDaysSinceOrder: { $avg: "$daysSinceLastOrder" } } },
      { $project: { _id: 0, segment: "$_id", customers: 1, avgOrders: { $round: ["$avgOrders", 1] }, avgLtvPaise: { $round: ["$avgLtvPaise", 0] }, avgDaysSinceOrder: { $round: ["$avgDaysSinceOrder", 0] } } },
      { $sort: { customers: -1 } },
    ], paging);
  },
});
