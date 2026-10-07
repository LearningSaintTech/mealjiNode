import { CouponRedemption } from "../coupon/coupon.model.js";
import { registerReport } from "../report/report.registry.js";
import { RewardTransaction } from "./ledger.model.js";
import { Referral } from "./rewards.model.js";

// Phase 3 reports: loyalty and offers.

const page = async (model, pipeline, paging) => {
  const [result] = await model.aggregate([...pipeline, { $facet: { rows: paging.all ? [{ $skip: 0 }] : [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: "n" }] } }]);
  return { rows: result.rows, total: result.total[0]?.n || 0 };
};

registerReport({
  key: "rewards_liability",
  title: "Rewards liability",
  category: "Payments & finance",
  description: "Points issued, redeemed and expired per day, and the outstanding value.",
  permission: "reports.finance",
  filters: ["dateRange"],
  columns: [
    { key: "date", label: "Date", type: "text" },
    { key: "issued", label: "Issued", type: "number" },
    { key: "redeemed", label: "Redeemed", type: "number" },
    { key: "expired", label: "Expired", type: "number" },
    { key: "reversed", label: "Reversed", type: "number" },
    { key: "net", label: "Net change", type: "number" },
  ],
  async run(filters, paging) {
    const sumIf = (types) => ({ $sum: { $cond: [{ $in: ["$type", types] }, { $abs: "$points" }, 0] } });
    return page(RewardTransaction, [
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, issued: sumIf(["earned", "adjusted"]), redeemed: sumIf(["redeemed"]), expired: sumIf(["expired"]), reversed: sumIf(["reversed"]), net: { $sum: "$points" } } },
      { $project: { _id: 0, date: "$_id", issued: 1, redeemed: 1, expired: 1, reversed: 1, net: 1 } },
      { $sort: { date: -1 } },
    ], paging);
  },
});

registerReport({
  key: "coupon_cost",
  title: "Coupon cost",
  category: "Payments & finance",
  description: "Redemptions, discount given and order value driven per coupon.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "code", label: "Code", type: "text" },
    { key: "redemptions", label: "Redemptions", type: "number" },
    { key: "customers", label: "Customers", type: "number" },
    { key: "discountPaise", label: "Discount given", type: "money" },
    { key: "gmvPaise", label: "Order value", type: "money" },
    { key: "roi", label: "Order value per ₹ discount", type: "number" },
  ],
  async run(filters, paging) {
    return page(CouponRedemption, [
      { $match: { status: "redeemed", createdAt: { $gte: filters.from, $lte: filters.to } } },
      { $lookup: { from: "orders", localField: "order", foreignField: "_id", as: "o" } },
      { $group: { _id: "$code", redemptions: { $sum: 1 }, customers: { $addToSet: "$user" }, discountPaise: { $sum: "$discountPaise" }, gmvPaise: { $sum: { $ifNull: [{ $first: "$o.bill.grandTotalPaise" }, 0] } } } },
      { $project: { _id: 0, code: "$_id", redemptions: 1, customers: { $size: "$customers" }, discountPaise: 1, gmvPaise: 1, roi: { $cond: [{ $gt: ["$discountPaise", 0] }, { $round: [{ $divide: ["$gmvPaise", "$discountPaise"] }, 2] }, null] } } },
      { $sort: { discountPaise: -1 } },
    ], paging);
  },
});

registerReport({
  key: "referrals",
  title: "Referrals",
  category: "Customers",
  description: "Referrers, referees, conversions and rejections.",
  permission: "reports.read",
  filters: ["dateRange", "status"],
  columns: [
    { key: "createdAt", label: "Joined", type: "datetime" },
    { key: "referrer", label: "Referrer", type: "text" },
    { key: "referee", label: "Friend", type: "text" },
    { key: "code", label: "Code", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "rejectReason", label: "Rejected because", type: "text" },
    { key: "convertedAt", label: "Converted", type: "datetime" },
  ],
  async run(filters, paging) {
    const match = { createdAt: { $gte: filters.from, $lte: filters.to }, ...(filters.status ? { status: filters.status } : {}) };
    return page(Referral, [
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "users", localField: "referrer", foreignField: "_id", as: "a" } },
      { $lookup: { from: "users", localField: "referee", foreignField: "_id", as: "b" } },
      { $project: { _id: 0, createdAt: 1, referrer: { $first: "$a.name" }, referee: { $first: "$b.name" }, code: 1, status: 1, rejectReason: 1, convertedAt: 1 } },
    ], paging);
  },
});
