// Adds Step 13–14 volume to the LOAD database: support tickets with
// conversations, and Meal Ji Plus members. Every generated document has
// loadTest: true (re-running replaces the earlier ones).
//
//   npm run load:generate-plus                       (default sizes)
//   npm run load:generate-plus -- --tickets=3 --members=10
//
// Sizes: --tickets (2 per customer on average; 1 in 100 customers has 60)
// --messages (4 per ticket) --members (percent of customers with a live plan, 10)
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const SIZE = { ticketsPerUser: arg("tickets", 2), messagesPerTicket: arg("messages", 4), memberPercent: arg("members", 10) };
const BATCH = 5_000;
let seed = 1414;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const daysAgo = (max) => new Date(Date.now() - random() * max * 86_400_000);
const dateKey = (date) => new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (key, days) => dateKey(new Date(new Date(`${key}T00:00:00+05:30`).getTime() + days * 86_400_000));

async function insertAll(collection, total, make) {
  for (let start = 0; start < total; start += BATCH) {
    const docs = [];
    for (let i = start; i < Math.min(total, start + BATCH); i += 1) docs.push(make(i));
    await collection.insertMany(docs, { ordered: false });
  }
}

await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
if (db.databaseName !== "mealji_load") throw new Error(`Refusing to write load data to ${db.databaseName}`);
for (const name of ["supporttickets", "ticketmessages", "subscriptions", "payments", "mealselections"]) await db.collection(name).deleteMany({ loadTest: true });

const users = await db.collection("users").find({ loadTest: true }).project({ _id: 1, name: 1, phoneNumber: 1 }).toArray();
const kitchen = await db.collection("kitchens").findOne({ status: "active", name: /koramangala/i });
const staff = await db.collection("users").findOne({ role: { $in: ["admin", "support", "super_admin"] } });
const categories = await db.collection("supportcategories").find({}).toArray();
const plans = await db.collection("subscriptionplans").find({ status: "active" }).toArray();
const orders = new Map((await db.collection("orders").aggregate([{ $match: { loadTest: true } }, { $group: { _id: "$user", order: { $first: "$_id" } } }]).toArray()).map((row) => [String(row._id), row.order]));

// ---- tickets: most customers 0–4, one in 100 has 60 (the heaviest list).
const plan = users.map((user, index) => ({ user, rows: index % 100 === 0 ? 60 : Math.floor(random() * (SIZE.ticketsPerUser * 2 + 1)) }));
const total = plan.reduce((sum, row) => sum + row.rows, 0);
let cursor = 0;
let left = plan[0].rows;
const STATUSES = ["open", "in_progress", "pending_customer", "resolved", "closed", "closed"];
const tickets = [];
await insertAll(db.collection("supporttickets"), total, (i) => {
  while (left === 0) {
    cursor += 1;
    left = plan[cursor].rows;
  }
  left -= 1;
  const { user } = plan[cursor];
  const category = pick(categories);
  const createdAt = daysAgo(365);
  const status = pick(STATUSES);
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    number: `T-L${String(i).padStart(7, "0")}`,
    user: user._id,
    category: category.key,
    issueType: pick(category.issueTypes?.length ? category.issueTypes : ["Other"]),
    order: category.key === "order" ? orders.get(String(user._id)) || null : null,
    subscription: null,
    kitchen: kitchen._id,
    subject: "Load test ticket",
    description: "Something went wrong with my order, please help.",
    attachments: [],
    status,
    priority: "normal",
    priorityRank: 1,
    assignee: staff ? { userId: staff._id, name: staff.name } : null,
    slaDueAt: new Date(createdAt.getTime() + 2 * 3600_000),
    slaBreached: false,
    firstResponseAt: new Date(createdAt.getTime() + 600_000),
    resolvedAt: ["resolved", "closed"].includes(status) ? new Date(createdAt.getTime() + 3600_000) : null,
    lastMessageAt: new Date(createdAt.getTime() + 3600_000),
    loadTest: true,
    createdAt,
    updatedAt: createdAt,
  };
  tickets.push(doc);
  return doc;
});
await insertAll(db.collection("ticketmessages"), tickets.length * SIZE.messagesPerTicket, (i) => {
  const ticket = tickets[Math.floor(i / SIZE.messagesPerTicket)];
  const mine = i % 2 === 0;
  return { ticket: ticket._id, author: mine ? { userId: ticket.user, role: "customer" } : { userId: staff?._id || null, role: "agent", name: staff?.name || "Support" }, body: mine ? "Please check this." : "Sorry about that! We are on it.", attachments: [], internal: false, loadTest: true, createdAt: new Date(ticket.createdAt.getTime() + (i % SIZE.messagesPerTicket) * 300_000) };
});

// ---- Meal Ji Plus members (live plans) with their first payment.
const members = users.filter((_, index) => index % Math.round(100 / SIZE.memberPercent) === 1);
const today = dateKey(new Date());
const subs = members.map((user) => {
  const chosen = pick(plans);
  const start = addDays(today, -Math.floor(random() * 25));
  const end = addDays(start, chosen.cycleDays - 1);
  return {
    _id: new mongoose.Types.ObjectId(),
    user: user._id,
    plan: chosen._id,
    planSnapshot: { planId: String(chosen._id), planCode: chosen.code, name: chosen.name, pricePaise: chosen.pricePaise, cycleDays: chosen.cycleDays, cycleLabel: chosen.cycleLabel, mealsPerDay: chosen.mealsPerDay, slots: chosen.slots, maxItemsPerMeal: chosen.maxItemsPerMeal, minItemsPerMeal: chosen.minItemsPerMeal, benefits: chosen.benefits, perks: chosen.perks, billingMethods: chosen.billingMethods, activeDays: chosen.activeDays, maxShiftsPerCycle: chosen.maxShiftsPerCycle, categoryIds: [], noSelectionPolicy: chosen.noSelectionPolicy, snapshotAt: new Date() },
    kitchen: kitchen._id,
    address: { addressId: null, label: "home", displayLabel: "Home", houseFlat: "Load test flat", city: "Bengaluru", state: "Karnataka", pincode: "560095", latitude: kitchen.latitude, longitude: kitchen.longitude, fullAddress: "Load test flat, Koramangala, Bengaluru, Karnataka, 560095" },
    status: random() < 0.9 ? "active" : "paused",
    billingMethod: "link",
    startDate: start,
    cycle: 1,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    validTill: end,
    nextBillingDate: addDays(end, 1),
    renewalPricePaise: chosen.pricePaise,
    autoRenew: true,
    shiftsThisCycle: 0,
    autoShiftsThisCycle: 0,
    renewalAttempts: 0,
    remindersSent: [],
    history: [{ at: new Date(), event: "activated", by: "system" }],
    loadTest: true,
    createdAt: new Date(`${start}T09:00:00+05:30`),
    updatedAt: new Date(),
  };
});
await insertAll(db.collection("subscriptions"), subs.length, (i) => subs[i]);
await insertAll(db.collection("payments"), subs.length, (i) => ({ user: subs[i].user, refType: "subscription", refId: subs[i]._id, kitchen: kitchen._id, amountPaise: subs[i].renewalPricePaise, method: "link", gateway: "test", gatewayOrderId: `order_load_${i}`, gatewayPaymentId: `pay_load_${i}`, status: "captured", cycle: 1, refundedPaise: 0, loadTest: true, createdAt: subs[i].createdAt, updatedAt: subs[i].createdAt }));
// Meal history: every past day of the plan, three meals, delivered.
const dishes = await db.collection("kitchendishes").find({ kitchen: kitchen._id, isActive: true }).project({ _id: 1, name: 1, isVeg: 1 }).limit(30).toArray();
const mealRows = [];
for (const sub of subs) {
  for (let day = sub.startDate; day < today; day = addDays(day, 1)) {
    for (const slot of ["breakfast", "lunch", "dinner"]) {
      const dish = pick(dishes);
      mealRows.push({ subscription: sub._id, user: sub.user, kitchen: kitchen._id, date: day, slot, items: [{ dish: dish._id, name: dish.name, qty: 1, isVeg: dish.isVeg !== false }], status: "delivered", source: "customer", cutoffAt: new Date(`${day}T04:30:00Z`), address: sub.address, timeline: [], loadTest: true, createdAt: new Date(`${day}T03:00:00Z`), updatedAt: new Date(`${day}T08:00:00Z`) });
    }
  }
}
await insertAll(db.collection("mealselections"), mealRows.length, (i) => mealRows[i]);

const ops = subs.map((sub) => ({ updateOne: { filter: { _id: sub.user }, update: { $set: { "subscription.planCode": sub.planSnapshot.planCode, "subscription.status": sub.status, "subscription.subscribedAt": sub.createdAt, "subscription.expiresAt": new Date(`${sub.validTill}T23:59:00+05:30`) } } } }));
for (let i = 0; i < ops.length; i += BATCH) await db.collection("users").bulkWrite(ops.slice(i, i + BATCH), { ordered: false });

for (const file of ["../../src/modules/support/support.model.js", "../../src/modules/subscription/subscription.model.js", "../../src/modules/payment/payment.model.js"]) await import(file);
await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes().catch((err) => console.warn(`  index sync ${model.modelName}: ${err.message}`))));
console.log(`Load database now holds: ${tickets.length} tickets (${tickets.length * SIZE.messagesPerTicket} messages), ${subs.length} Plus members, ${mealRows.length} past meals`);
await mongoose.disconnect();
