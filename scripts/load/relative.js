// Busy-machine fallback: times each endpoint one call at a time (no concurrency)
// for a normal and the heaviest customer, next to reference endpoints. Ratios
// stay meaningful even when the machine is loaded; absolute numbers do not.
//
//   node --import ./scripts/load/loadEnv.js scripts/load/relative.js
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";
import { signAccessToken } from "../../src/infrastructure/token.service.js";

const BASE = `http://localhost:${env.port}/api/v1`;
const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] || 15);
await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const heavyId = (await db.collection("rewardtransactions").aggregate([{ $match: { loadTest: true } }, { $sortByCount: "$user" }, { $limit: 1 }]).toArray())[0]._id;
const normal = await db.collection("users").findOne({ loadTest: true, _id: { $ne: heavyId } }, { sort: { _id: -1 } });
const rows = async (id) => db.collection("rewardtransactions").countDocuments({ user: id });
const users = [["normal", normal._id, await rows(normal._id)], ["heaviest", heavyId, await rows(heavyId)]];
await mongoose.disconnect();

const PATHS = ["/app/config", "/menu", "/home", "/rewards/overview", "/rewards/history?period=all&limit=20", "/rewards/history?period=this_month&limit=20", "/referrals/me", "/rewards/redemptions", "/promos/available", "/wallet"];
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
for (const [label, id, ledger] of users) {
  const headers = { Authorization: `Bearer ${signAccessToken({ userId: id, role: "user" }).token}`, "x-device-id": `relative-${label}` };
  console.log(`\n${label} customer (${ledger} points-history rows)`);
  for (const path of PATHS) {
    const times = [];
    let status = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const started = performance.now();
      const res = await fetch(`${BASE}${path}`, { headers });
      await res.text();
      status = res.status;
      times.push(performance.now() - started);
    }
    console.log(`  ${String(status)} ${path.padEnd(44)} median ${String(Math.round(median(times))).padStart(4)} ms  best ${String(Math.round(Math.min(...times))).padStart(4)} ms`);
  }
}
