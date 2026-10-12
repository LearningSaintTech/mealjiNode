// Runs the queries behind the Step 01–12 APIs on the LOAD database and reads
// MongoDB's query plans: every query must use an index and read about as many
// documents as it returns. A full collection scan (COLLSCAN) or a query that
// reads far more than it returns fails the check.
//
//   npm run load:indexes
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";

await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const user = await db.collection("users").findOne({ loadTest: true }, { sort: { _id: -1 } });
const kitchen = await db.collection("kitchens").findOne({ status: "active", name: /koramangala/i });
const dishes = await db.collection("kitchendishes").find({ kitchen: kitchen._id }).limit(30).project({ _id: 1 }).toArray();
if (!user || !kitchen) {
  console.error("No load data: run npm run load:seed first");
  process.exit(1);
}
const weekAgo = new Date(Date.now() - 7 * 86_400_000);
// Step 12 uses the customer with the biggest points ledger (1 in 100 has 50x the rows).
const heavy = (await db.collection("rewardtransactions").aggregate([{ $match: { loadTest: true } }, { $sortByCount: "$user" }, { $limit: 1 }]).toArray())[0]?._id || user._id;
const monthStart = new Date(Date.now() - 30 * 86_400_000);

const CHECKS = [
  ["02 sign-in: user by phone", "users", { find: { countryCode: "+91", phoneNumber: user.phoneNumber } }],
  ["03 profile: orders count", "orders", { find: { user: user._id, status: { $nin: ["payment_pending", "payment_failed"] } } }],
  ["03 profile: favourites", "favorites", { find: { user: user._id } }],
  ["04 addresses list", "addresses", { find: { user: user._id, deletedAt: null }, sort: { isDefault: -1, updatedAt: -1 } }],
  ["05 home: unread notifications", "notifications", { find: { user: user._id, isRead: false } }],
  ["05 home: your usual", "orders", { aggregate: [{ $match: { user: user._id, kitchen: kitchen._id, status: "delivered" } }, { $sort: { createdAt: -1 } }, { $limit: 30 }] }],
  ["06 menu: live dishes of a kitchen", "kitchendishes", { find: { kitchen: kitchen._id, isActive: true, approvalStatus: "live" }, sort: { sortOrder: 1, name: 1 } }],
  ["06/07 hearts on a dish list", "favorites", { find: { user: user._id, dish: { $in: dishes.map((dish) => dish._id) } } }],
  ["07 favourites list", "favorites", { find: { user: user._id }, sort: { createdAt: -1 }, limit: 200 }],
  ["07 search: recent", "searchlogs", { aggregate: [{ $match: { user: user._id, hiddenFromRecent: false } }, { $sort: { createdAt: -1 } }, { $limit: 200 }] }],
  ["07 search: typing (last minute)", "searchlogs", { find: { user: user._id, createdAt: { $gte: new Date(Date.now() - 60_000) } }, sort: { createdAt: -1 }, limit: 1 }],
  ["08 cart: the customer's cart", "carts", { find: { user: user._id } }],
  ["08 offers: customer's past coupon use", "couponredemptions", { aggregate: [{ $match: { user: user._id, status: { $in: ["reserved", "redeemed"] } } }, { $group: { _id: "$coupon", total: { $sum: 1 } } }] }],
  ["08 offers: delivered orders (first-order offers)", "orders", { find: { user: user._id, status: "delivered" } }],
  ["11 inbox page (a tab)", "notifications", { find: { user: user._id, category: "orders" }, sort: { createdAt: -1 }, limit: 20 }],
  ["11 unread per tab", "notifications", { aggregate: [{ $match: { user: user._id, isRead: false } }, { $group: { _id: "$category", n: { $sum: 1 } } }] }],
  ["12 points history page", "rewardtransactions", { find: { user: heavy }, sort: { createdAt: -1 }, limit: 20 }],
  ["12 points history: This Month", "rewardtransactions", { find: { user: heavy, createdAt: { $gte: monthStart } }, sort: { createdAt: -1 }, limit: 20 }],
  ["12 expiring soon (points card)", "rewardtransactions", { aggregate: [{ $match: { user: heavy, remaining: { $gt: 0 }, expiresAt: { $ne: null, $lte: new Date(Date.now() + 30 * 86_400_000) } } }, { $group: { _id: null, points: { $sum: "$remaining" } } }] }],
  ["12 redeem: oldest lots first", "rewardtransactions", { find: { user: heavy, remaining: { $gt: 0 } }, sort: { expiresAt: 1, createdAt: 1 } }],
  ["12 daily job: expired lots", "rewardtransactions", { find: { remaining: { $gt: 0 }, expiresAt: { $ne: null, $lte: new Date() } }, limit: 5000 }],
  ["12 my reward codes", "rewardredemptions", { find: { user: user._id }, sort: { createdAt: -1 }, limit: 50 }],
  ["12 offers: my reward codes", "coupons", { find: { owner: user._id, isActive: true }, limit: 50 }],
  ["12 referral code lookup", "users", { find: { referralCode: "LOADREF0" } }],
  ["12 my referrals", "referrals", { find: { referrer: user._id }, sort: { createdAt: -1 }, limit: 100 }],
  ["12 referral payout check", "referrals", { find: { referee: user._id, status: "pending" } }],
  ["07 search: trending (7 days)", "searchlogs", { aggregate: [{ $match: { createdAt: { $gte: weekAgo }, results: { $gt: 0 } } }, { $group: { _id: "$normalized", n: { $sum: 1 } } }], allowScan: true }],
];

function stagesOf(plan, out = []) {
  if (!plan) return out;
  out.push(plan.stage);
  if (plan.inputStage) stagesOf(plan.inputStage, out);
  (plan.inputStages || []).forEach((child) => stagesOf(child, out));
  if (plan.queryPlan) stagesOf(plan.queryPlan, out);
  return out;
}
function findStats(explain) {
  if (explain.executionStats) return { stats: explain.executionStats, plan: explain.queryPlanner?.winningPlan };
  const cursor = explain.stages?.[0]?.$cursor || explain;
  return { stats: cursor.executionStats || {}, plan: cursor.queryPlanner?.winningPlan };
}

const rows = [];
for (const [name, collection, spec] of CHECKS) {
  const coll = db.collection(collection);
  const explain = spec.aggregate
    ? await coll.aggregate(spec.aggregate).explain("executionStats")
    : await coll.find(spec.find, { sort: spec.sort, limit: spec.limit }).explain("executionStats");
  const { stats, plan } = findStats(explain);
  const stages = stagesOf(plan);
  const scan = stages.includes("COLLSCAN");
  const examined = stats.totalDocsExamined ?? 0;
  const returned = stats.nReturned ?? 0;
  const wasteful = examined > returned * 5 + 50;
  const ok = spec.allowScan ? true : !scan && !wasteful;
  rows.push({ name, ok, plan: [...new Set(stages)].join("<"), examined, returned, ms: stats.executionTimeMillis ?? null, note: spec.allowScan ? "aggregate over 7 days; cached 10 min by the API" : "" });
}

const total = await db.collection("users").estimatedDocumentCount();
console.log(`Query plans on ${db.databaseName} (${total.toLocaleString("en-IN")} users)\n`);
for (const row of rows) console.log(`${row.ok ? "✓" : "✗"} ${row.name.padEnd(36)} ${String(row.ms).padStart(4)} ms  read ${String(row.examined).padStart(7)} → ${String(row.returned).padStart(5)}  ${row.plan}${row.note ? `  (${row.note})` : ""}`);
const fs = await import("node:fs");
fs.mkdirSync("test-reports", { recursive: true });
fs.writeFileSync("test-reports/load-indexes.json", JSON.stringify({ runAt: new Date().toISOString(), users: total, rows }, null, 2));
await mongoose.disconnect();
process.exit(rows.every((row) => row.ok) ? 0 : 1);
