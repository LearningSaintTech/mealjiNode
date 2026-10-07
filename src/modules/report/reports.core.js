import mongoose from "mongoose";
import { istDateKey } from "../../common/time.js";
import { AuditLog } from "../audit/audit.model.js";
import { DeliveryJob } from "../delivery/delivery.model.js";
import { Order } from "../order/order.model.js";
import { Payment, Refund } from "../payment/payment.model.js";
import { Role } from "../role/role.model.js";
import { User } from "../user/user.model.js";
import { registerReport } from "./report.registry.js";

// Phase 1 core reports: sales, orders & operations, payments & finance,
// customers, ratings, admin & security.

const oid = (value) => (value ? new mongoose.Types.ObjectId(String(value)) : null);
const minutes = (from, to) => (from && to ? Math.round((new Date(to) - new Date(from)) / 60_000) : null);

function orderMatch(filters, extra = {}) {
  const match = { createdAt: { $gte: filters.from, $lte: filters.to }, ...extra };
  if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
  return match;
}

async function paged(model, pipeline, { skip, limit, all }) {
  const [result] = await model.aggregate([
    ...pipeline,
    { $facet: { rows: all ? [{ $skip: 0 }] : [{ $skip: skip }, { $limit: limit }], total: [{ $count: "n" }] } },
  ]).allowDiskUse(true);
  return { rows: result.rows, total: result.total[0]?.n || 0 };
}

registerReport({
  key: "daily_sales",
  title: "Daily sales summary",
  category: "Sales",
  description: "Orders, GMV, discounts, net and AOV per day and kitchen, with the COD/online split.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  maxRangeDays: 366,
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "cancelled", label: "Cancelled", type: "number" },
    { key: "gmvPaise", label: "GMV", type: "money" },
    { key: "discountPaise", label: "Discounts", type: "money" },
    { key: "refundedPaise", label: "Refunds", type: "money" },
    { key: "netPaise", label: "Net", type: "money" },
    { key: "aovPaise", label: "AOV", type: "money" },
    { key: "codOrders", label: "COD", type: "number" },
    { key: "onlineOrders", label: "Online", type: "number" },
  ],
  async run(filters, paging) {
    const pipeline = [
      { $match: orderMatch(filters, { status: { $nin: ["payment_pending", "payment_failed"] } }) },
      {
        $group: {
          _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, kitchen: "$kitchenName" },
          orders: { $sum: 1 },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          gmvPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.grandTotalPaise", 0] } },
          discountPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.discountPaise", 0] } },
          refundedPaise: { $sum: "$refundedPaise" },
          codOrders: { $sum: { $cond: [{ $eq: ["$paymentMethod", "cod"] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0, date: "$_id.date", kitchen: "$_id.kitchen", orders: 1, cancelled: 1, gmvPaise: 1, discountPaise: 1, refundedPaise: 1, codOrders: 1,
          onlineOrders: { $subtract: ["$orders", "$codOrders"] },
          netPaise: { $subtract: [{ $subtract: ["$gmvPaise", "$discountPaise"] }, "$refundedPaise"] },
          aovPaise: { $cond: [{ $gt: [{ $subtract: ["$orders", "$cancelled"] }, 0] }, { $round: [{ $divide: ["$gmvPaise", { $subtract: ["$orders", "$cancelled"] }] }, 0] }, 0] },
        },
      },
      { $sort: { date: -1, kitchen: 1 } },
    ];
    const result = await paged(Order, pipeline, paging);
    // Same rules as the rows: orders count cancelled ones, money excludes them.
    const totals = (await Order.aggregate([
      { $match: orderMatch(filters, { status: { $nin: ["payment_pending", "payment_failed"] } }) },
      { $group: { _id: null, orders: { $sum: 1 }, cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } }, gmvPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.grandTotalPaise", 0] } }, discountPaise: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$bill.discountPaise", 0] } }, refundedPaise: { $sum: "$refundedPaise" } } },
    ]))[0];
    return { ...result, totals: totals ? { orders: totals.orders, cancelled: totals.cancelled, gmvPaise: totals.gmvPaise, discountPaise: totals.discountPaise, refundedPaise: totals.refundedPaise, netPaise: totals.gmvPaise - totals.discountPaise - totals.refundedPaise } : null };
  },
});

registerReport({
  key: "sales_by_dish",
  title: "Sales by dish",
  category: "Sales",
  description: "Quantity, revenue and share for each dish and combo.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "name", label: "Item", type: "text" },
    { key: "kind", label: "Type", type: "text" },
    { key: "qty", label: "Quantity", type: "number" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "revenuePaise", label: "Revenue", type: "money" },
    { key: "share", label: "Share", type: "percent" },
  ],
  async run(filters, paging) {
    const match = orderMatch(filters, { status: { $in: ["placed", "accepted", "preparing", "ready", "dispatched", "delivered"] } });
    const [total] = await Order.aggregate([{ $match: match }, { $unwind: "$items" }, { $group: { _id: null, revenue: { $sum: "$items.totalPaise" } } }]);
    const pipeline = [
      { $match: match },
      { $unwind: "$items" },
      { $group: { _id: { name: "$items.name", kind: "$items.kind" }, qty: { $sum: "$items.qty" }, orders: { $sum: 1 }, revenuePaise: { $sum: "$items.totalPaise" } } },
      { $project: { _id: 0, name: "$_id.name", kind: "$_id.kind", qty: 1, orders: 1, revenuePaise: 1, share: total?.revenue ? { $round: [{ $divide: ["$revenuePaise", total.revenue] }, 4] } : 0 } },
      { $sort: { revenuePaise: -1 } },
    ];
    return { ...(await paged(Order, pipeline, paging)), totals: { revenuePaise: total?.revenue || 0 } };
  },
});

registerReport({
  key: "order_register",
  title: "Order register",
  category: "Orders & operations",
  description: "Every order with status, amounts, payment, kitchen and rider.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId", "status"],
  kitchenScoped: true,
  columns: [
    { key: "orderNumber", label: "Order", type: "text" },
    { key: "placedAt", label: "Placed", type: "datetime" },
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "customer", label: "Customer", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "items", label: "Items", type: "number" },
    { key: "totalPaise", label: "Total", type: "money" },
    { key: "paymentMethod", label: "Payment", type: "text" },
    { key: "paymentStatus", label: "Payment status", type: "text" },
    { key: "deliveryMode", label: "Mode", type: "text" },
    { key: "rider", label: "Rider", type: "text" },
    { key: "deliveredAt", label: "Delivered", type: "datetime" },
  ],
  async run(filters, paging) {
    const match = orderMatch(filters, filters.status ? { status: filters.status } : {});
    const [rows, total] = await Promise.all([
      Order.find(match).sort({ createdAt: -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Order.countDocuments(match),
    ]);
    return {
      total,
      rows: rows.map((order) => ({
        orderNumber: order.orderNumber,
        placedAt: order.placedAt || order.createdAt,
        kitchen: order.kitchenName,
        customer: order.customer?.name || "",
        status: order.status,
        items: (order.items || []).reduce((sum, item) => sum + item.qty, 0),
        totalPaise: order.bill?.grandTotalPaise || 0,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        deliveryMode: order.deliveryMode,
        rider: order.rider?.name || "",
        deliveredAt: order.deliveredAt,
      })),
    };
  },
});

registerReport({
  key: "kitchen_sla",
  title: "Kitchen SLA",
  category: "Orders & operations",
  description: "Accept, prep and delivery times, on-time rate and breaches per kitchen.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "avgAcceptMinutes", label: "Accept (min)", type: "number" },
    { key: "avgPrepMinutes", label: "Prep (min)", type: "number" },
    { key: "avgDispatchMinutes", label: "Ready → out (min)", type: "number" },
    { key: "avgDeliveryMinutes", label: "Placed → delivered (min)", type: "number" },
    { key: "onTimeRate", label: "On time", type: "percent" },
    { key: "slaBreaches", label: "Accept breaches", type: "number" },
  ],
  async run(filters, paging) {
    const diff = (a, b) => ({ $cond: [{ $and: [`$${a}`, `$${b}`] }, { $divide: [{ $subtract: [`$${b}`, `$${a}`] }, 60000] }, null] });
    const pipeline = [
      { $match: orderMatch(filters, { status: { $nin: ["payment_pending", "payment_failed"] } }) },
      {
        $group: {
          _id: "$kitchenName",
          orders: { $sum: 1 },
          accept: { $avg: diff("placedAt", "acceptedAt") },
          prep: { $avg: diff("acceptedAt", "readyAt") },
          dispatch: { $avg: diff("readyAt", "dispatchedAt") },
          delivery: { $avg: diff("placedAt", "deliveredAt") },
          delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
          onTime: { $sum: { $cond: [{ $and: ["$deliveredAt", { $lte: ["$deliveredAt", "$estimatedDeliveryAt"] }] }, 1, 0] } },
          slaBreaches: { $sum: { $cond: ["$slaAlertedAt", 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0, kitchen: "$_id", orders: 1, slaBreaches: 1,
          avgAcceptMinutes: { $round: ["$accept", 1] }, avgPrepMinutes: { $round: ["$prep", 1] }, avgDispatchMinutes: { $round: ["$dispatch", 1] }, avgDeliveryMinutes: { $round: ["$delivery", 1] },
          onTimeRate: { $cond: [{ $gt: ["$delivered", 0] }, { $round: [{ $divide: ["$onTime", "$delivered"] }, 3] }, null] },
        },
      },
      { $sort: { orders: -1 } },
    ];
    return paged(Order, pipeline, paging);
  },
});

registerReport({
  key: "cancellations",
  title: "Cancellations & refunds",
  category: "Orders & operations",
  description: "Why orders were cancelled, by whom, at which stage, and what was refunded.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "orderNumber", label: "Order", type: "text" },
    { key: "cancelledAt", label: "Cancelled", type: "datetime" },
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "by", label: "By", type: "text" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "stage", label: "Stage", type: "text" },
    { key: "totalPaise", label: "Order total", type: "money" },
    { key: "refundedPaise", label: "Refunded", type: "money" },
  ],
  async run(filters, paging) {
    const match = { status: "cancelled", cancelledAt: { $gte: filters.from, $lte: filters.to } };
    if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
    const [rows, total] = await Promise.all([
      Order.find(match).sort({ cancelledAt: -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Order.countDocuments(match),
    ]);
    return {
      total,
      rows: rows.map((order) => {
        const history = order.statusHistory || [];
        return {
          orderNumber: order.orderNumber,
          cancelledAt: order.cancelledAt,
          kitchen: order.kitchenName,
          by: order.cancellation?.by || "",
          reason: order.cancellation?.reason || "",
          stage: history.length > 1 ? history[history.length - 2].status : "",
          totalPaise: order.bill?.grandTotalPaise || 0,
          refundedPaise: order.refundedPaise || 0,
        };
      }),
    };
  },
});

registerReport({
  key: "delivery_performance",
  title: "Delivery performance",
  category: "Orders & operations",
  description: "Per provider: deliveries, pickup wait, delivery time, failures and cost.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "provider", label: "Provider", type: "text" },
    { key: "jobs", label: "Jobs", type: "number" },
    { key: "delivered", label: "Delivered", type: "number" },
    { key: "failed", label: "Failed / cancelled", type: "number" },
    { key: "rebooked", label: "Re-booked", type: "number" },
    { key: "avgPickupWaitMinutes", label: "Pickup wait (min)", type: "number" },
    { key: "avgDeliveryMinutes", label: "Pickup → drop (min)", type: "number" },
    { key: "costPaise", label: "Cost", type: "money" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to } };
    if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
    const pipeline = [
      { $match: match },
      {
        $group: {
          _id: "$provider",
          jobs: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $in: ["$status", ["failed", "cancelled"]] }, 1, 0] } },
          rebooked: { $sum: { $cond: [{ $gt: ["$attempts", 1] }, 1, 0] } },
          wait: { $avg: { $cond: [{ $and: ["$bookedAt", "$pickedUpAt"] }, { $divide: [{ $subtract: ["$pickedUpAt", "$bookedAt"] }, 60000] }, null] } },
          ride: { $avg: { $cond: [{ $and: ["$pickedUpAt", "$deliveredAt"] }, { $divide: [{ $subtract: ["$deliveredAt", "$pickedUpAt"] }, 60000] }, null] } },
          costPaise: { $sum: { $ifNull: ["$costPaise", 0] } },
        },
      },
      { $project: { _id: 0, provider: "$_id", jobs: 1, delivered: 1, failed: 1, rebooked: 1, costPaise: 1, avgPickupWaitMinutes: { $round: ["$wait", 1] }, avgDeliveryMinutes: { $round: ["$ride", 1] } } },
      { $sort: { jobs: -1 } },
    ];
    return paged(DeliveryJob, pipeline, paging);
  },
});

registerReport({
  key: "payment_register",
  title: "Payment register",
  category: "Payments & finance",
  description: "Every payment with reference, method, amount, gateway fee and status.",
  permission: "reports.finance",
  filters: ["dateRange", "status"],
  columns: [
    { key: "createdAt", label: "Date", type: "datetime" },
    { key: "refType", label: "For", type: "text" },
    { key: "gatewayPaymentId", label: "Payment ID", type: "text" },
    { key: "method", label: "Method", type: "text" },
    { key: "amountPaise", label: "Amount", type: "money" },
    { key: "feePaise", label: "Gateway fee", type: "money" },
    { key: "refundedPaise", label: "Refunded", type: "money" },
    { key: "status", label: "Status", type: "text" },
    { key: "settlementId", label: "Settlement", type: "text" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to }, ...(filters.status ? { status: filters.status } : {}) };
    const [rows, total, sums] = await Promise.all([
      Payment.find(match).sort({ createdAt: -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Payment.countDocuments(match),
      Payment.aggregate([{ $match: { ...match, status: { $in: ["captured", "refunded", "partially_refunded"] } } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, feePaise: { $sum: "$feePaise" }, refundedPaise: { $sum: "$refundedPaise" } } }]),
    ]);
    return {
      total,
      totals: sums[0] ? { amountPaise: sums[0].amountPaise, feePaise: sums[0].feePaise, refundedPaise: sums[0].refundedPaise } : null,
      rows: rows.map((payment) => ({ createdAt: payment.createdAt, refType: payment.refType, gatewayPaymentId: payment.gatewayPaymentId || "", method: payment.method || "", amountPaise: payment.amountPaise, feePaise: payment.feePaise || 0, refundedPaise: payment.refundedPaise || 0, status: payment.status, settlementId: payment.settlementId || "" })),
    };
  },
});

registerReport({
  key: "settlement_reconciliation",
  title: "Settlement reconciliation",
  category: "Payments & finance",
  description: "Captured vs refunded vs fees per day: what the gateway should settle.",
  permission: "reports.finance",
  filters: ["dateRange"],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "payments", label: "Payments", type: "number" },
    { key: "capturedPaise", label: "Captured", type: "money" },
    { key: "refundedPaise", label: "Refunded", type: "money" },
    { key: "feePaise", label: "Fees + tax", type: "money" },
    { key: "expectedSettlementPaise", label: "Expected settlement", type: "money" },
    { key: "unsettled", label: "Without settlement ID", type: "number" },
  ],
  async run(filters, paging) {
    const pipeline = [
      { $match: { gateway: { $ne: "cod" }, capturedAt: { $gte: filters.from, $lte: filters.to } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$capturedAt", timezone: "Asia/Kolkata" } },
          payments: { $sum: 1 },
          capturedPaise: { $sum: "$amountPaise" },
          refundedPaise: { $sum: "$refundedPaise" },
          feePaise: { $sum: { $add: ["$feePaise", "$taxOnFeePaise"] } },
          unsettled: { $sum: { $cond: [{ $eq: ["$settlementId", null] }, 1, 0] } },
        },
      },
      { $project: { _id: 0, date: "$_id", payments: 1, capturedPaise: 1, refundedPaise: 1, feePaise: 1, unsettled: 1, expectedSettlementPaise: { $subtract: [{ $subtract: ["$capturedPaise", "$refundedPaise"] }, "$feePaise"] } } },
      { $sort: { date: -1 } },
    ];
    return paged(Payment, pipeline, paging);
  },
});

registerReport({
  key: "refund_register",
  title: "Refund register",
  category: "Payments & finance",
  description: "Every refund with amount, reason, approval and status.",
  permission: "reports.finance",
  filters: ["dateRange", "status"],
  columns: [
    { key: "createdAt", label: "Requested", type: "datetime" },
    { key: "orderNumber", label: "Order", type: "text" },
    { key: "amountPaise", label: "Amount", type: "money" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "requestedBy", label: "Requested by", type: "text" },
    { key: "approvedBy", label: "Approved by", type: "text" },
    { key: "processedAt", label: "Processed", type: "datetime" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to }, ...(filters.status ? { status: filters.status } : {}) };
    const [rows, total] = await Promise.all([
      Refund.find(match).populate("order", "orderNumber").sort({ createdAt: -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Refund.countDocuments(match),
    ]);
    return { total, rows: rows.map((refund) => ({ createdAt: refund.createdAt, orderNumber: refund.order?.orderNumber || "", amountPaise: refund.amountPaise, reason: refund.reason, status: refund.status, requestedBy: refund.requestedBy?.name || refund.requestedBy?.role || "", approvedBy: refund.reviewedBy?.name || "", processedAt: refund.processedAt })) };
  },
});

registerReport({
  key: "ratings",
  title: "Ratings & feedback",
  category: "Product",
  description: "Rated orders with food and delivery scores, tags and comments (low ratings first).",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "ratedAt", label: "Rated", type: "datetime" },
    { key: "orderNumber", label: "Order", type: "text" },
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "food", label: "Food", type: "number" },
    { key: "delivery", label: "Delivery", type: "number" },
    { key: "tags", label: "Tags", type: "text" },
    { key: "comment", label: "Comment", type: "text" },
  ],
  async run(filters, paging) {
    const match = { "rating.at": { $gte: filters.from, $lte: filters.to } };
    if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
    const [rows, total] = await Promise.all([
      Order.find(match).sort({ "rating.food": 1, "rating.at": -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Order.countDocuments(match),
    ]);
    return { total, rows: rows.map((order) => ({ ratedAt: order.rating.at, orderNumber: order.orderNumber, kitchen: order.kitchenName, food: order.rating.food, delivery: order.rating.delivery, tags: (order.rating.tags || []).join(", "), comment: order.rating.comment || "" })) };
  },
});

registerReport({
  key: "customer_register",
  title: "Customer register",
  category: "Customers",
  description: "Customers with signup date, orders, lifetime value, last order, Plus status and tier.",
  permission: "reports.read",
  filters: ["dateRange"],
  maxRangeDays: 3660,
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "signupAt", label: "Signed up", type: "date" },
    { key: "orders", label: "Delivered orders", type: "number" },
    { key: "ltvPaise", label: "Lifetime value", type: "money" },
    { key: "lastOrderAt", label: "Last order", type: "date" },
    { key: "plus", label: "Plus", type: "text" },
    { key: "tier", label: "Tier", type: "text" },
    { key: "points", label: "Points", type: "number" },
  ],
  async run(filters, paging) {
    const role = await Role.findOne({ slug: "user" }).select("_id").lean();
    const match = { role: role?._id, deletedAt: null, createdAt: { $gte: filters.from, $lte: filters.to } };
    const pipeline = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "orders", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$user", "$$id"] }, status: "delivered" } }, { $group: { _id: null, orders: { $sum: 1 }, ltv: { $sum: "$bill.grandTotalPaise" }, last: { $max: "$createdAt" } } }], as: "stats" } },
      { $project: { _id: 0, name: 1, phone: "$phoneNumber", signupAt: "$createdAt", orders: { $ifNull: [{ $first: "$stats.orders" }, 0] }, ltvPaise: { $ifNull: [{ $first: "$stats.ltv" }, 0] }, lastOrderAt: { $first: "$stats.last" }, plus: "$subscription.status", tier: { $ifNull: ["$tier", ""] }, points: { $ifNull: ["$pointsBalance", 0] } } },
    ];
    return paged(User, pipeline, paging);
  },
});

registerReport({
  key: "audit_export",
  title: "Audit log export",
  category: "Admin & security",
  description: "Who changed what, with before and after.",
  permission: "audit.read",
  filters: ["dateRange", "kitchenId"],
  columns: [
    { key: "createdAt", label: "When", type: "datetime" },
    { key: "actor", label: "Who", type: "text" },
    { key: "role", label: "Role", type: "text" },
    { key: "action", label: "Action", type: "text" },
    { key: "summary", label: "Summary", type: "text" },
    { key: "reason", label: "Reason", type: "text" },
    { key: "before", label: "Before", type: "text" },
    { key: "after", label: "After", type: "text" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to } };
    if (filters.kitchenId) match.kitchenId = oid(filters.kitchenId);
    const [rows, total] = await Promise.all([
      AuditLog.find(match).sort({ createdAt: -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      AuditLog.countDocuments(match),
    ]);
    return { total, rows: rows.map((row) => ({ createdAt: row.createdAt, actor: row.actorName || "System", role: row.actorRole || "", action: row.action, summary: row.summary, reason: row.reason || "", before: row.before ? JSON.stringify(row.before) : "", after: row.after ? JSON.stringify(row.after) : "" })) };
  },
});

registerReport({
  key: "staff_access",
  title: "Staff access review",
  category: "Admin & security",
  description: "Every console account with role, kitchen, status and last sign-in.",
  permission: "users.read",
  filters: [],
  columns: [
    { key: "name", label: "Name", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "role", label: "Role", type: "text" },
    { key: "scope", label: "Console", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "lastLoginAt", label: "Last sign-in", type: "datetime" },
    { key: "createdAt", label: "Created", type: "date" },
  ],
  async run(filters, paging) {
    const roles = await Role.find({ scope: { $in: ["platform", "kitchen"] } }).lean();
    const byId = new Map(roles.map((role) => [String(role._id), role]));
    const match = { role: { $in: roles.map((role) => role._id) } };
    const [rows, total] = await Promise.all([
      User.find(match).sort({ createdAt: 1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      User.countDocuments(match),
    ]);
    return {
      total,
      rows: rows.map((user) => {
        const role = byId.get(String(user.role));
        return { name: user.name, phone: user.phoneNumber, role: role?.name || "", scope: role?.scope || "", status: user.suspendedAt ? "suspended" : user.isNumberVerified ? "active" : "invited", lastLoginAt: user.lastLoginAt, createdAt: user.createdAt };
      }),
    };
  },
});

registerReport({
  key: "not_serviceable_demand",
  title: "Not-serviceable demand",
  category: "Customers",
  description: "Where people looked for MealJi and no kitchen covered them (expansion signal).",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "pincode", label: "Pincode", type: "text" },
    { key: "checks", label: "Checks", type: "number" },
    { key: "people", label: "People", type: "number" },
    { key: "lastSeen", label: "Last seen", type: "datetime" },
  ],
  async run(filters, paging) {
    const { DemandLog } = await import("../serviceability/demandLog.model.js");
    const pipeline = [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      { $group: { _id: { $ifNull: ["$pincode", { $concat: [{ $toString: { $round: ["$latitude", 2] } }, ",", { $toString: { $round: ["$longitude", 2] } }] }] }, checks: { $sum: 1 }, people: { $addToSet: "$userId" }, lastSeen: { $max: "$createdAt" } } },
      { $project: { _id: 0, pincode: "$_id", checks: 1, people: { $size: "$people" }, lastSeen: 1 } },
      { $sort: { checks: -1 } },
    ];
    return paged(DemandLog, pipeline, paging);
  },
});

export const CORE_REPORTS_LOADED = istDateKey();

registerReport({
  key: "dish_performance",
  title: "Dish performance",
  category: "Product",
  description: "Views, add-to-cart rate, orders, rating and reorder rate per dish.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "name", label: "Dish", type: "text" },
    { key: "views", label: "Views", type: "number" },
    { key: "addToCart", label: "Added to cart", type: "number" },
    { key: "addRate", label: "Add rate", type: "percent" },
    { key: "orders", label: "Orders", type: "number" },
    { key: "qty", label: "Quantity", type: "number" },
    { key: "repeatCustomers", label: "Repeat customers", type: "number" },
    { key: "rating", label: "Rating", type: "number" },
  ],
  async run(filters, paging) {
    const { AnalyticsEvent } = await import("../analytics/analytics.model.js");
    const { KitchenDish } = await import("../catalog/catalog.model.js");
    const match = orderMatch(filters, { status: "delivered" });
    const sales = await Order.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $match: { "items.dish": { $ne: null } } },
      { $group: { _id: { dish: "$items.dish", user: "$user" }, name: { $first: "$items.name" }, orders: { $sum: 1 }, qty: { $sum: "$items.qty" } } },
      { $group: { _id: "$_id.dish", name: { $first: "$name" }, orders: { $sum: "$orders" }, qty: { $sum: "$qty" }, repeatCustomers: { $sum: { $cond: [{ $gt: ["$orders", 1] }, 1, 0] } } } },
    ]);
    const events = await AnalyticsEvent.aggregate([
      { $match: { occurredAt: { $gte: filters.from, $lte: filters.to }, "meta.name": { $in: ["dish_viewed", "add_to_cart"] } } },
      { $group: { _id: { dish: "$properties.dishId", name: "$meta.name" }, total: { $sum: 1 } } },
    ]);
    const counts = new Map();
    for (const row of events) {
      const entry = counts.get(String(row._id.dish)) || { views: 0, addToCart: 0 };
      if (row._id.name === "dish_viewed") entry.views = row.total;
      else entry.addToCart = row.total;
      counts.set(String(row._id.dish), entry);
    }
    const dishFilter = filters.kitchenId ? { kitchen: oid(filters.kitchenId) } : {};
    const dishes = await KitchenDish.find(dishFilter).select("name ratingAvg").lean();
    const byId = new Map(sales.map((row) => [String(row._id), row]));
    const rows = dishes.map((dish) => {
      const sale = byId.get(String(dish._id)) || { orders: 0, qty: 0, repeatCustomers: 0 };
      const event = counts.get(String(dish._id)) || { views: 0, addToCart: 0 };
      return { name: dish.name, views: event.views, addToCart: event.addToCart, addRate: event.views ? Math.round((event.addToCart / event.views) * 1000) / 1000 : null, orders: sale.orders, qty: sale.qty, repeatCustomers: sale.repeatCustomers, rating: Math.round((dish.ratingAvg || 0) * 10) / 10 };
    }).sort((a, b) => b.qty - a.qty);
    return { total: rows.length, rows: paging.all ? rows : rows.slice(paging.skip, paging.skip + paging.limit) };
  },
});
