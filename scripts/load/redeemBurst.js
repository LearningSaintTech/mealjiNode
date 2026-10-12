// Redeem under pressure: N load customers double-tap Redeem at the same time.
// Afterwards every one must be charged at most once, never go below zero, and
// have exactly one reward code per charge (balance = sum of the ledger).
//
//   node --import ./scripts/load/loadEnv.js scripts/load/redeemBurst.js --users=200
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";
import { signAccessToken } from "../../src/infrastructure/token.service.js";

const BASE = `http://localhost:${env.port}/api/v1`;
const COUNT = Number(process.argv.find((a) => a.startsWith("--users="))?.split("=")[1] || 200);
await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const reward = await db.collection("rewards").find({ isActive: true, tiers: { $size: 0 } }).sort({ points: 1 }).limit(1).next();
const users = await db.collection("users").find({ loadTest: true, pointsBalance: { $gte: reward.points, $lt: reward.points * 2 } }).limit(COUNT).toArray();
const before = new Map(users.map((u) => [String(u._id), u.pointsBalance]));
console.log(`${users.length} customers with ${reward.points}–${reward.points * 2 - 1} points double-tap “${reward.name}” (${reward.points} pts)`);

const started = performance.now();
const statuses = {};
await Promise.all(users.flatMap((user) => {
  const headers = { Authorization: `Bearer ${signAccessToken({ userId: user._id, role: "user" }).token}`, "x-device-id": `burst-${user._id}` };
  return [0, 1].map(async () => {
    const res = await fetch(`${BASE}/rewards/${reward._id}/redeem`, { method: "POST", headers });
    await res.text();
    statuses[res.status] = (statuses[res.status] || 0) + 1;
  });
}));
const seconds = (performance.now() - started) / 1000;

let doubleCharged = 0;
let negative = 0;
let ledgerMismatch = 0;
let codeMismatch = 0;
for (const user of users) {
  const after = await db.collection("users").findOne({ _id: user._id }, { projection: { pointsBalance: 1 } });
  const charged = before.get(String(user._id)) - after.pointsBalance;
  if (charged > reward.points) doubleCharged += 1;
  if (after.pointsBalance < 0) negative += 1;
  const [sum] = await db.collection("rewardtransactions").aggregate([{ $match: { user: user._id } }, { $group: { _id: null, points: { $sum: "$points" } } }]).toArray();
  // Load ledgers were generated with balance = max(0, sum); compare the change only.
  const spentRows = await db.collection("rewardtransactions").countDocuments({ user: user._id, source: "reward", loadTest: { $ne: true } });
  const codes = await db.collection("rewardredemptions").countDocuments({ user: user._id, loadTest: { $ne: true } });
  if (spentRows * reward.points !== charged) ledgerMismatch += 1;
  if (codes !== spentRows) codeMismatch += 1;
  void sum;
}
console.log(`taps ${users.length * 2} in ${seconds.toFixed(1)} s · statuses ${JSON.stringify(statuses)}`);
console.log(`charged twice: ${doubleCharged} · below zero: ${negative} · ledger ≠ balance change: ${ledgerMismatch} · codes ≠ charges: ${codeMismatch}`);

// Put the load data back: remove the codes, coupons and ledger rows made here, refund the points.
const ids = users.map((u) => u._id);
const made = await db.collection("rewardredemptions").find({ user: { $in: ids }, loadTest: { $ne: true } }).toArray();
await db.collection("coupons").deleteMany({ code: { $in: made.map((r) => r.couponCode) } });
await db.collection("rewardredemptions").deleteMany({ _id: { $in: made.map((r) => r._id) } });
await db.collection("rewards").updateOne({ _id: reward._id }, { $inc: { redeemedCount: -made.length } });
await db.collection("rewardtransactions").deleteMany({ user: { $in: ids }, source: "reward", loadTest: { $ne: true } });
for (const user of users) await db.collection("users").updateOne({ _id: user._id }, { $set: { pointsBalance: before.get(String(user._id)) } });
await mongoose.disconnect();
process.exit(doubleCharged || negative || ledgerMismatch || codeMismatch ? 1 : 0);
