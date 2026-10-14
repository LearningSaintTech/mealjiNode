// Step 13–14 endpoints timed one call at a time (busy-machine fallback, like
// relative.js): a normal customer, the customer with the most tickets, and a
// Plus member, next to reference endpoints. Also prints the query plans.
//
//   npm run load:relative-plus
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";
import { signAccessToken } from "../../src/infrastructure/token.service.js";

const BASE = `http://localhost:${env.port}/api/v1`;
const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.split("=")[1] || 15);
await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const heavy = (await db.collection("supporttickets").aggregate([{ $match: { loadTest: true } }, { $sortByCount: "$user" }, { $limit: 1 }]).toArray())[0];
const normal = await db.collection("users").findOne({ loadTest: true, "subscription.status": { $nin: ["active", "paused"] }, _id: { $ne: heavy._id } }, { sort: { _id: -1 } });
const member = await db.collection("subscriptions").findOne({ loadTest: true, status: "active" });
const ticket = await db.collection("supporttickets").findOne({ user: heavy._id }, { sort: { createdAt: -1 } });
const address = await db.collection("addresses").findOne({ user: normal._id, deletedAt: null });
const explain = async (name, collection, filter, sort) => {
  const plan = await db.collection(collection).find(filter).sort(sort).limit(10).explain("executionStats");
  const stats = plan.executionStats;
  console.log(`  plan ${name}: ${stats.totalDocsExamined} docs / ${stats.totalKeysExamined} keys examined for ${stats.nReturned} returned`);
};
console.log("query plans");
await explain("ticket list (heaviest)", "supporttickets", { user: heavy._id }, { createdAt: -1 });
await explain("ticket messages", "ticketmessages", { ticket: ticket._id, internal: { $ne: true } }, { createdAt: 1 });
await explain("member's meals in a week", "mealselections", { subscription: member._id, date: { $in: ["2026-10-14", "2026-10-15"] } }, { date: 1 });
await explain("live plan (member)", "subscriptions", { user: member.user, status: { $in: ["active", "pause_scheduled", "paused", "cancel_scheduled", "past_due"] } }, { createdAt: -1 });
await mongoose.disconnect();

const tomorrow = new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const runs = [
  [`normal customer`, normal._id, ["/app/config", "/users/me", "/subscription-plans", "/subscription-plans/STANDARD_MONTHLY", "/subscriptions/me", `/subscriptions/checkout/summary?planCode=STANDARD_MONTHLY&addressId=${address?._id}`, "/support/config", "/support/categories", "/support/faqs?limit=6", "/support/faqs?q=refund", "/support/tickets?page=1&limit=10"]],
  [`heaviest tickets (${heavy.count})`, heavy._id, ["/support/tickets?page=1&limit=10", "/support/tickets?page=3&limit=10", `/support/tickets/${ticket._id}`]],
  ["Plus member", member.user, ["/subscriptions/me", "/home", "/subscriptions/me/week", `/subscriptions/me/days/${tomorrow}`, `/subscriptions/me/menu?date=${tomorrow}&slot=lunch`, `/subscriptions/me/days/${tomorrow}/slots/lunch/selection`, `/subscriptions/me/shift-preview?date=${tomorrow}&slot=lunch`, "/subscriptions/me/change-plan", "/subscriptions/me/change-plan/preview?planCode=PREMIUM_MONTHLY", "/subscriptions/me/pause-options", "/subscriptions/me/cancel-reasons", "/subscriptions/me/invoices"]],
];
for (const [label, id, paths] of runs) {
  const headers = { Authorization: `Bearer ${signAccessToken({ userId: id, role: "user" }).token}`, "x-device-id": `relative-plus-${label.split(" ")[0]}` };
  console.log(`\n${label}`);
  for (const path of paths) {
    const times = [];
    let status = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const started = performance.now();
      const res = await fetch(`${BASE}${path}`, { headers });
      await res.text();
      status = res.status;
      times.push(performance.now() - started);
    }
    console.log(`  ${String(status)} ${path.replace(/[a-f0-9]{24}/g, ":id").padEnd(62)} median ${String(Math.round(median(times))).padStart(4)} ms  best ${String(Math.round(Math.min(...times))).padStart(4)} ms`);
  }
}
