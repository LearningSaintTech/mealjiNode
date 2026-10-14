// One call at a time (no concurrency): how long Redeem and Place order take by
// themselves on the load data. Undoes what it creates.
//   node --import ./scripts/load/loadEnv.js scripts/load/writeTiming.js
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";
import { signAccessToken } from "../../src/infrastructure/token.service.js";

const BASE = `http://localhost:${env.port}/api/v1`;
await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const reward = await db.collection("rewards").find({ isActive: true, tiers: { $size: 0 } }).sort({ points: 1 }).limit(1).next();
const heavy = (await db.collection("rewardtransactions").aggregate([{ $match: { loadTest: true } }, { $sortByCount: "$user" }, { $limit: 1 }]).toArray())[0]._id;
const users = [heavy, ...(await db.collection("users").find({ loadTest: true, pointsBalance: { $gte: 2000 } }).limit(9).project({ _id: 1 }).toArray()).map((u) => u._id)];
const before = new Map((await db.collection("users").find({ _id: { $in: users } }).project({ pointsBalance: 1 }).toArray()).map((u) => [String(u._id), u.pointsBalance]));
await db.collection("users").updateOne({ _id: heavy }, { $max: { pointsBalance: 2000 } });
const call = async (id, method, path, body) => {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${signAccessToken({ userId: id, role: "user" }).token}`, "x-device-id": `write-timing-${id}` }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { ms: performance.now() - started, status: res.status, json };
};
const redeem = [];
for (const id of users) redeem.push(await call(id, "POST", `/rewards/${reward._id}/redeem`));
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
console.log(`Redeem ×${redeem.length}: statuses ${[...new Set(redeem.map((r) => r.status))].join(",")} · median ${Math.round(median(redeem.map((r) => r.ms)))} ms · heaviest customer ${Math.round(redeem[0].ms)} ms`);
// clean up the codes made here
const made = await db.collection("rewardredemptions").find({ user: { $in: users }, loadTest: { $ne: true } }).toArray();
await db.collection("coupons").deleteMany({ code: { $in: made.map((r) => r.couponCode) } });
await db.collection("rewardredemptions").deleteMany({ _id: { $in: made.map((r) => r._id) } });
await db.collection("rewardtransactions").deleteMany({ user: { $in: users }, source: "reward", loadTest: { $ne: true } });
await db.collection("rewards").updateOne({ _id: reward._id }, { $inc: { redeemedCount: -made.length } });
for (const [id, points] of before) await db.collection("users").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { pointsBalance: points } });
await mongoose.disconnect();
