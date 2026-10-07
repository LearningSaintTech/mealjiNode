import mongoose from "mongoose";
import { istDateKey } from "../../common/time.js";
import { Invoice } from "../billing/billing.model.js";
import { registerReport } from "../report/report.registry.js";
import { MealSelection, Subscription } from "./subscription.model.js";

// Phase 2 reports: subscriptions, meal selection, production and GST.

const oid = (value) => (value ? new mongoose.Types.ObjectId(String(value)) : null);
const page = async (model, pipeline, paging) => {
  const [result] = await model.aggregate([...pipeline, { $facet: { rows: paging.all ? [{ $skip: 0 }] : [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: "n" }] } }]);
  return { rows: result.rows, total: result.total[0]?.n || 0 };
};

registerReport({
  key: "subscriber_register",
  title: "Subscriber register",
  category: "Subscriptions",
  description: "Every subscription with plan, status, dates and billing method.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId", "status", "planCode"],
  maxRangeDays: 3660,
  kitchenScoped: true,
  columns: [
    { key: "customer", label: "Customer", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "plan", label: "Plan", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "billingMethod", label: "Billing", type: "text" },
    { key: "startDate", label: "Started", type: "text" },
    { key: "validTill", label: "Valid till", type: "text" },
    { key: "nextBillingDate", label: "Next bill", type: "text" },
    { key: "pricePaise", label: "Price", type: "money" },
    { key: "cycle", label: "Cycle", type: "number" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to }, status: { $ne: "pending_payment" } };
    if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
    if (filters.status) match.status = filters.status;
    if (filters.planCode) match["planSnapshot.planCode"] = String(filters.planCode).toUpperCase();
    return page(Subscription, [
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "u" } },
      { $project: { _id: 0, customer: { $first: "$u.name" }, phone: { $first: "$u.phoneNumber" }, plan: "$planSnapshot.name", status: 1, billingMethod: 1, startDate: 1, validTill: 1, nextBillingDate: 1, pricePaise: { $ifNull: ["$renewalPricePaise", "$planSnapshot.pricePaise"] }, cycle: 1 } },
    ], paging);
  },
});

registerReport({
  key: "churn_reasons",
  title: "Churn & cancel reasons",
  category: "Subscriptions",
  description: "Why subscribers cancel, per plan, and how many undid it.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "reason", label: "Reason", type: "text" },
    { key: "plan", label: "Plan", type: "text" },
    { key: "cancellations", label: "Cancellations", type: "number" },
    { key: "undone", label: "Still active (undone)", type: "number" },
  ],
  async run(filters, paging) {
    return page(Subscription, [
      { $match: { "cancellation.requestedAt": { $gte: filters.from, $lte: filters.to } } },
      { $group: { _id: { reason: { $ifNull: ["$cancellation.reason", "Not given"] }, plan: "$planSnapshot.name" }, cancellations: { $sum: 1 }, undone: { $sum: { $cond: [{ $eq: ["$status", "active"] }, 1, 0] } } } },
      { $project: { _id: 0, reason: "$_id.reason", plan: "$_id.plan", cancellations: 1, undone: 1 } },
      { $sort: { cancellations: -1 } },
    ], paging);
  },
});

registerReport({
  key: "meal_selection",
  title: "Meal selection",
  category: "Subscriptions",
  description: "Per date and slot: chosen, defaulted, auto-shifted, manually shifted, skipped and delivered.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  columns: [
    { key: "date", label: "Date", type: "text" },
    { key: "slot", label: "Slot", type: "text" },
    { key: "chosen", label: "Chosen", type: "number" },
    { key: "defaulted", label: "Default / repeat", type: "number" },
    { key: "autoShifted", label: "Auto-shifted", type: "number" },
    { key: "manualShifted", label: "Shifted by customer", type: "number" },
    { key: "skipped", label: "Skipped", type: "number" },
    { key: "delivered", label: "Delivered", type: "number" },
  ],
  async run(filters, paging) {
    const match = { date: { $gte: filters.fromKey, $lte: filters.toKey } };
    if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
    const sum = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
    return page(MealSelection, [
      { $match: match },
      {
        $group: {
          _id: { date: "$date", slot: "$slot" },
          chosen: sum({ $eq: ["$source", "customer"] }),
          defaulted: sum({ $in: ["$source", ["chef_default", "repeat_last"]] }),
          autoShifted: sum({ $and: [{ $eq: ["$status", "shifted"] }, { $eq: ["$shiftKind", "auto"] }] }),
          manualShifted: sum({ $and: [{ $eq: ["$status", "shifted"] }, { $eq: ["$shiftKind", "manual"] }] }),
          skipped: sum({ $eq: ["$status", "skipped"] }),
          delivered: sum({ $eq: ["$status", "delivered"] }),
        },
      },
      { $project: { _id: 0, date: "$_id.date", slot: "$_id.slot", chosen: 1, defaulted: 1, autoShifted: 1, manualShifted: 1, skipped: 1, delivered: 1 } },
      { $sort: { date: -1, slot: 1 } },
    ], paging);
  },
});

registerReport({
  key: "production_sheet",
  title: "Kitchen production sheet",
  category: "Subscriptions",
  description: "Dishes and quantities per kitchen, date and slot.",
  permission: "reports.read",
  filters: ["dateRange", "kitchenId"],
  kitchenScoped: true,
  maxRangeDays: 14,
  columns: [
    { key: "date", label: "Date", type: "text" },
    { key: "kitchen", label: "Kitchen", type: "text" },
    { key: "slot", label: "Slot", type: "text" },
    { key: "dish", label: "Dish", type: "text" },
    { key: "qty", label: "Quantity", type: "number" },
  ],
  async run(filters, paging) {
    const match = { date: { $gte: filters.fromKey, $lte: filters.toKey }, status: { $in: ["selected", "locked", "out_for_delivery", "delivered"] } };
    if (filters.kitchenId) match.kitchen = oid(filters.kitchenId);
    return page(MealSelection, [
      { $match: match },
      { $unwind: "$items" },
      { $group: { _id: { date: "$date", kitchen: "$kitchen", slot: "$slot", dish: "$items.name" }, qty: { $sum: "$items.qty" } } },
      { $lookup: { from: "kitchens", localField: "_id.kitchen", foreignField: "_id", as: "k" } },
      { $project: { _id: 0, date: "$_id.date", kitchen: { $first: "$k.name" }, slot: "$_id.slot", dish: "$_id.dish", qty: 1 } },
      { $sort: { date: 1, kitchen: 1, slot: 1, qty: -1 } },
    ], paging);
  },
});

registerReport({
  key: "renewal_failures",
  title: "Renewal failures / past due",
  category: "Subscriptions",
  description: "Subscribers whose renewal did not go through.",
  permission: "reports.read",
  filters: [],
  columns: [
    { key: "customer", label: "Customer", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "plan", label: "Plan", type: "text" },
    { key: "billingMethod", label: "Billing", type: "text" },
    { key: "pastDueSince", label: "Due since", type: "text" },
    { key: "attempts", label: "Attempts", type: "number" },
    { key: "paymentLink", label: "Payment link", type: "text" },
  ],
  async run(filters, paging) {
    return page(Subscription, [
      { $match: { status: "past_due" } },
      { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "u" } },
      { $project: { _id: 0, customer: { $first: "$u.name" }, phone: { $first: "$u.phoneNumber" }, plan: "$planSnapshot.name", billingMethod: 1, pastDueSince: 1, attempts: "$renewalAttempts", paymentLink: "$paymentLink.url" } },
    ], paging);
  },
});

registerReport({
  key: "gst_report",
  title: "GST report (GSTR-1 ready)",
  category: "Payments & finance",
  description: "Invoice-wise taxable value with CGST/SGST/IGST and SAC, plus the B2C summary by state.",
  permission: "reports.finance",
  filters: ["dateRange"],
  maxRangeDays: 92,
  columns: [
    { key: "invoiceNumber", label: "Invoice", type: "text" },
    { key: "date", label: "Date", type: "text" },
    { key: "entity", label: "Issued by", type: "text" },
    { key: "gstin", label: "GSTIN", type: "text" },
    { key: "placeOfSupply", label: "Place of supply", type: "text" },
    { key: "sac", label: "SAC", type: "text" },
    { key: "taxablePaise", label: "Taxable value", type: "money" },
    { key: "cgstPaise", label: "CGST", type: "money" },
    { key: "sgstPaise", label: "SGST", type: "money" },
    { key: "igstPaise", label: "IGST", type: "money" },
    { key: "totalPaise", label: "Invoice value", type: "money" },
  ],
  async run(filters, paging) {
    const match = { issuedAt: { $gte: filters.from, $lte: filters.to }, status: "issued" };
    const [rows, total, sums] = await Promise.all([
      Invoice.find(match).sort({ issuedAt: 1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Invoice.countDocuments(match),
      Invoice.aggregate([{ $match: match }, { $group: { _id: null, taxablePaise: { $sum: "$taxablePaise" }, cgstPaise: { $sum: "$cgstPaise" }, sgstPaise: { $sum: "$sgstPaise" }, igstPaise: { $sum: "$igstPaise" }, totalPaise: { $sum: "$totalPaise" } } }]),
    ]);
    return {
      total,
      totals: sums[0] ? { taxablePaise: sums[0].taxablePaise, cgstPaise: sums[0].cgstPaise, sgstPaise: sums[0].sgstPaise, igstPaise: sums[0].igstPaise, totalPaise: sums[0].totalPaise } : null,
      rows: rows.map((invoice) => ({
        invoiceNumber: invoice.invoiceNumber,
        date: istDateKey(invoice.issuedAt),
        entity: invoice.entitySnapshot?.legalName || "",
        gstin: invoice.entitySnapshot?.gstin || "",
        placeOfSupply: invoice.placeOfSupply || "",
        sac: [...new Set((invoice.lines || []).map((line) => line.sac).filter(Boolean))].join("/"),
        taxablePaise: invoice.taxablePaise,
        cgstPaise: invoice.cgstPaise,
        sgstPaise: invoice.sgstPaise,
        igstPaise: invoice.igstPaise,
        totalPaise: invoice.totalPaise,
      })),
    };
  },
});

registerReport({
  key: "invoice_register",
  title: "Invoice register",
  category: "Payments & finance",
  description: "Every invoice issued for orders and subscriptions.",
  permission: "reports.finance",
  filters: ["dateRange"],
  columns: [
    { key: "invoiceNumber", label: "Invoice", type: "text" },
    { key: "date", label: "Date", type: "text" },
    { key: "customer", label: "Customer", type: "text" },
    { key: "refType", label: "For", type: "text" },
    { key: "periodLabel", label: "Period", type: "text" },
    { key: "totalPaise", label: "Amount", type: "money" },
    { key: "status", label: "Status", type: "text" },
  ],
  async run(filters, paging) {
    const match = { issuedAt: { $gte: filters.from, $lte: filters.to } };
    const [rows, total] = await Promise.all([
      Invoice.find(match).sort({ issuedAt: -1 }).skip(paging.all ? 0 : paging.skip).limit(paging.all ? 0 : paging.limit).lean(),
      Invoice.countDocuments(match),
    ]);
    return { total, rows: rows.map((invoice) => ({ invoiceNumber: invoice.invoiceNumber, date: istDateKey(invoice.issuedAt), customer: invoice.customer?.name || "", refType: invoice.refType, periodLabel: invoice.periodLabel || "", totalPaise: invoice.totalPaise, status: invoice.status })) };
  },
});
