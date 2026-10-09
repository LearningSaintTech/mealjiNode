// Load test for the Step 01–07 APIs: many signed-in customers using the app at
// the same time against the LOAD API (npm run load:api, port 4100).
//
//   npm run load:run                              (stages 25, 100, 250 concurrent; 30 s each)
//   npm run load:run -- --stages=50,200 --seconds=60
//
// Each virtual user (VU) repeatedly opens a screen and makes that screen's API
// calls with no pause, so “250 concurrent” means 250 requests in flight at all
// times. Real people pause for seconds between taps, so the number of app users
// this serves is far higher (see “≈ active app users” in the report).
// Pass/fail per stage: p95 under the target for that kind of call, no 5xx, no
// network errors, under 1% unexpected 4xx.
import "./loadEnv.js";
import fs from "node:fs";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";
import { signAccessToken } from "../../src/infrastructure/token.service.js";

const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const STAGES = String(arg("stages", "25,100,250")).split(",").map(Number);
const SECONDS = Number(arg("seconds", 30));
const BASE = `${String(arg("base", `http://localhost:${env.port}`)).replace(/\/$/, "")}/api/v1`;
const SECONDS_BETWEEN_TAPS = 5; // a real user makes about one call every 5 s while using the app
const TARGET_P95_MS = { read: 300, heavy: 600, write: 500 };

await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
const maxVus = Math.max(...STAGES);
const users = await db.collection("users").aggregate([{ $match: { loadTest: true } }, { $sample: { size: maxVus * 2 } }, { $project: { _id: 1, phoneNumber: 1 } }]).toArray();
const kitchen = await db.collection("kitchens").findOne({ status: "active", name: /koramangala/i });
const dishIds = (await db.collection("kitchendishes").find({ kitchen: kitchen._id, isActive: true, approvalStatus: "live" }).project({ _id: 1 }).toArray()).map((dish) => String(dish._id));
// Dishes that can go in a cart with no choices (no required option groups).
const plainDishIds = (await db.collection("kitchendishes").find({ kitchen: kitchen._id, isActive: true, approvalStatus: "live", "customizationGroups.minSelect": { $not: { $gt: 0 } } }).project({ _id: 1 }).limit(100).toArray()).map((dish) => String(dish._id));
const comboIds = (await db.collection("kitchencombos").find({ kitchen: kitchen._id, isActive: true }).project({ _id: 1 }).toArray()).map((combo) => String(combo._id));
const point = { latitude: kitchen.latitude, longitude: kitchen.longitude };
await mongoose.disconnect();
if (users.length < maxVus) throw new Error(`Only ${users.length} load users; run npm run load:seed`);

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const QUERIES = ["butter", "biryani", "paneer", "bao", "briyani", "kulfi", "naan", "sushi", "wrap", "cheesecake"];

// ---------------------------------------------------------------- metrics
const metrics = new Map();
function record(name, kind, ms, status, error) {
  if (!metrics.has(name)) metrics.set(name, { kind, times: [], statuses: {}, errors: 0 });
  const m = metrics.get(name);
  m.times.push(ms);
  if (error) m.errors += 1;
  else m.statuses[status] = (m.statuses[status] || 0) + 1;
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

async function call(vu, name, kind, method, path, body, { expect = [200, 201] } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-device-id": vu.deviceId, ...(vu.token ? { Authorization: `Bearer ${vu.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    record(name, kind, performance.now() - started, expect.includes(res.status) ? "ok" : res.status, false);
    try {
      return { status: res.status, data: JSON.parse(text).data };
    } catch {
      return { status: res.status, data: null };
    }
  } catch (err) {
    record(name, kind, performance.now() - started, null, true);
    return { status: 0, data: null, error: err.message };
  }
}

// ---------------------------------------------------------------- screens (weights ≈ how often people open them)
const SCREENS = [
  [2, "01 App start", async (vu) => {
    await call(vu, "GET /app/config", "read", "GET", "/app/config");
    await call(vu, "GET /onboarding/slides", "read", "GET", "/onboarding/slides");
  }],
  [1, "02 Sign in (OTP)", async (vu) => {
    const anon = { deviceId: vu.deviceId };
    const login = await call(anon, "POST /auth/login", "write", "POST", "/auth/login", { countryCode: "+91", phoneNumber: vu.phone }, { expect: [201, 429] });
    if (login.data?.userId) await call(anon, "POST /auth/verify-otp", "write", "POST", "/auth/verify-otp", { userId: login.data.userId, otp: env.fixedOtp }, { expect: [201, 429] });
  }],
  [3, "02 Session check", async (vu) => {
    await call(vu, "GET /auth/me", "read", "GET", "/auth/me");
  }],
  [3, "03 Profile", async (vu) => {
    await call(vu, "GET /users/me", "read", "GET", "/users/me");
    await call(vu, "GET /users/me/preferences", "read", "GET", "/users/me/preferences");
    if (Math.random() < 0.2) await call(vu, "PATCH /users/me", "write", "PATCH", "/users/me", { name: `Load User ${vu.index}` });
  }],
  [4, "04 Location and addresses", async (vu) => {
    const jitter = { latitude: point.latitude + (Math.random() - 0.5) * 0.02, longitude: point.longitude + (Math.random() - 0.5) * 0.02 };
    await call(vu, "PUT /users/me/location", "write", "PUT", "/users/me/location", jitter, { expect: [200, 429] });
    await call(vu, "GET /users/me/addresses", "read", "GET", "/users/me/addresses");
    await call(vu, "GET /serviceability", "read", "GET", `/serviceability?latitude=${jitter.latitude}&longitude=${jitter.longitude}`);
    if (Math.random() < 0.1) {
      const made = await call(vu, "POST /users/me/addresses", "write", "POST", "/users/me/addresses", { label: "Other", customLabel: "Load test", houseFlat: "1 Load St", city: "Bengaluru", pincode: "560034", ...jitter });
      if (made.data?.addressId) await call(vu, "DELETE /users/me/addresses/:id", "write", "DELETE", `/users/me/addresses/${made.data.addressId}`);
    }
  }],
  [12, "05 Home", async (vu) => {
    await call(vu, "GET /home", "heavy", "GET", Math.random() < 0.3 ? "/home?veg=true" : "/home");
    await call(vu, "GET /in-app-messages", "read", "GET", "/in-app-messages?screen=home");
    if (Math.random() < 0.2) await call(vu, "GET /kitchen-about", "read", "GET", "/kitchen-about");
    if (Math.random() < 0.2) await call(vu, "GET /dishes/filters", "read", "GET", "/dishes/filters");
  }],
  [10, "06 Menu and dish", async (vu) => {
    await call(vu, "GET /menu", "heavy", "GET", "/menu");
    const dishId = pick(dishIds);
    await call(vu, "GET /menu/items/:id", "read", "GET", `/menu/items/${dishId}`);
    await call(vu, "GET /menu/items/:id/recommendations", "read", "GET", `/menu/items/${dishId}/recommendations`);
    if (Math.random() < 0.4) await call(vu, "GET /dishes (filtered page)", "read", "GET", "/dishes?quick=veg&sort=rating&limit=20&page=1");
    if (Math.random() < 0.4) await call(vu, "GET /combos", "read", "GET", "/combos");
    if (comboIds.length && Math.random() < 0.2) await call(vu, "GET /combos/:id", "read", "GET", `/combos/${pick(comboIds)}`);
  }],
  [7, "07 Search and favourites", async (vu) => {
    if (Math.random() < 0.3) {
      await call(vu, "GET /search/trending", "read", "GET", "/search/trending");
      await call(vu, "GET /search/recent", "read", "GET", "/search/recent");
    }
    await call(vu, "GET /search", "read", "GET", `/search?q=${pick(QUERIES)}`);
    const dishId = pick(dishIds);
    if (Math.random() < 0.3) {
      await call(vu, "POST /users/me/favorites", "write", "POST", "/users/me/favorites", { dishId });
      await call(vu, "DELETE /users/me/favorites/:id", "write", "DELETE", `/users/me/favorites/${dishId}`);
    }
    await call(vu, "GET /users/me/favorites", "read", "GET", "/users/me/favorites");
  }],
  [6, "08 Cart and checkout", async (vu) => {
    if (!vu.cartReady) {
      await call(vu, "DELETE /cart", "write", "DELETE", "/cart");
      vu.cartReady = true;
    }
    const added = await call(vu, "POST /cart/items", "write", "POST", "/cart/items", { dishId: pick(plainDishIds) }, { expect: [201, 409] });
    await call(vu, "GET /cart", "heavy", "GET", "/cart");
    const line = added.data?.items?.[0];
    if (line && Math.random() < 0.5) await call(vu, "PATCH /cart/items/:id", "write", "PATCH", `/cart/items/${line.lineId}`, { qty: 1 + Math.floor(Math.random() * 3) });
    if (Math.random() < 0.4) await call(vu, "GET /promos/available", "read", "GET", "/promos/available");
    if (Math.random() < 0.3) await call(vu, "GET /delivery/slots", "read", "GET", "/delivery/slots");
    if (Math.random() < 0.3) await call(vu, "GET /cart/recommendations", "read", "GET", "/cart/recommendations");
    await call(vu, "POST /checkout/summary", "heavy", "POST", "/checkout/summary", { paymentMethod: "upi" });
    if (added.data?.items?.length > 6) await call(vu, "DELETE /cart", "write", "DELETE", "/cart");
  }],
  [2, "09 Place order and pay", async (vu) => {
    await call(vu, "DELETE /cart", "write", "DELETE", "/cart");
    await call(vu, "POST /cart/items", "write", "POST", "/cart/items", { dishId: pick(plainDishIds), qty: 2 }, { expect: [201, 409] });
    const online = Math.random() < 0.5;
    const placed = await call(vu, "POST /orders", "write", "POST", "/orders", { paymentMethod: online ? "upi" : "cod" }, { expect: [201, 409] });
    const orderId = placed.data?.order?.orderId;
    if (online && placed.data?.payment?.gatewayOrderId) {
      await call(vu, "POST /payments/test/complete (pay + verify)", "write", "POST", "/payments/test/complete", { gatewayOrderId: placed.data.payment.gatewayOrderId });
    }
    if (orderId) await call(vu, "GET /orders/:id", "read", "GET", `/orders/${orderId}`);
  }],
  [4, "10 Orders and tracking", async (vu) => {
    const list = await call(vu, "GET /orders (tabs)", "read", "GET", `/orders?status=${Math.random() < 0.5 ? "active" : "past"}&limit=10`);
    const pick1 = list.data?.items?.[0];
    if (pick1) {
      await call(vu, "GET /orders/:id", "read", "GET", `/orders/${pick1.orderId}`);
      if (Math.random() < 0.5) await call(vu, "GET /orders/:id/live", "read", "GET", `/orders/${pick1.orderId}/live`);
      if (Math.random() < 0.3) await call(vu, "GET /orders/:id/tracking", "read", "GET", `/orders/${pick1.orderId}/tracking`);
    }
  }],
  [3, "11 Notifications", async (vu) => {
    await call(vu, "GET /notifications/unread-count", "read", "GET", "/notifications/unread-count");
    const inbox = await call(vu, "GET /notifications", "read", "GET", `/notifications?category=${pick(["all", "orders", "offers", "rewards", "account"])}&limit=20`);
    const unread = inbox.data?.items?.find((n) => !n.isRead);
    if (unread && Math.random() < 0.5) await call(vu, "PATCH /notifications/:id/read", "write", "PATCH", `/notifications/${unread.notificationId}/read`);
  }],
];
const totalWeight = SCREENS.reduce((sum, [weight]) => sum + weight, 0);
function pickScreen() {
  let roll = Math.random() * totalWeight;
  for (const screen of SCREENS) {
    roll -= screen[0];
    if (roll <= 0) return screen;
  }
  return SCREENS[0];
}

// ---------------------------------------------------------------- stages
const vus = users.slice(0, maxVus).map((user, index) => ({
  index,
  phone: user.phoneNumber,
  deviceId: `load-device-${String(index).padStart(5, "0")}`,
  token: signAccessToken({ userId: user._id, role: "user" }).token,
}));

const health = await fetch(`${BASE.replace(/\/api\/v1$/, "")}/health`).catch(() => null);
if (!health?.ok) throw new Error(`Load API is not running at ${BASE} (npm run load:api)`);
console.log(`Load test ${BASE} · stages ${STAGES.join(", ")} concurrent · ${SECONDS} s each`);

const report = { runAt: new Date().toISOString(), base: BASE, seconds: SECONDS, stages: [] };
for (const concurrency of STAGES) {
  metrics.clear();
  const until = Date.now() + SECONDS * 1000;
  const started = Date.now();
  await Promise.all(vus.slice(0, concurrency).map(async (vu) => {
    while (Date.now() < until) await pickScreen()[2](vu);
  }));
  const elapsed = (Date.now() - started) / 1000;
  const endpoints = [...metrics.entries()].map(([name, m]) => {
    const sorted = [...m.times].sort((a, b) => a - b);
    const count = sorted.length;
    const bad5xx = Object.entries(m.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, n]) => sum + n, 0);
    const bad4xx = Object.entries(m.statuses).filter(([status]) => Number(status) >= 400 && Number(status) < 500).reduce((sum, [, n]) => sum + n, 0);
    const p95 = pct(sorted, 95);
    const target = TARGET_P95_MS[m.kind];
    return {
      name, kind: m.kind, count, rps: Math.round((count / elapsed) * 10) / 10,
      p50: Math.round(pct(sorted, 50)), p95: Math.round(p95), p99: Math.round(pct(sorted, 99)), max: Math.round(sorted.at(-1) || 0),
      errors: m.errors, status5xx: bad5xx, status4xx: bad4xx, statuses: m.statuses,
      ok: p95 <= target && !bad5xx && !m.errors && bad4xx <= count * 0.01, target,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const requests = endpoints.reduce((sum, e) => sum + e.count, 0);
  const all = [...metrics.values()].flatMap((m) => m.times).sort((a, b) => a - b);
  const stage = {
    concurrency, seconds: Math.round(elapsed), requests, rps: Math.round(requests / elapsed),
    p50: Math.round(pct(all, 50)), p95: Math.round(pct(all, 95)), p99: Math.round(pct(all, 99)),
    activeUsersServed: Math.round((requests / elapsed) * SECONDS_BETWEEN_TAPS),
    ok: endpoints.every((e) => e.ok), endpoints,
  };
  report.stages.push(stage);
  console.log(`\n${concurrency} concurrent · ${stage.requests} requests · ${stage.rps} req/s · p50 ${stage.p50} ms · p95 ${stage.p95} ms · p99 ${stage.p99} ms · ≈ ${stage.activeUsersServed.toLocaleString("en-IN")} active app users · ${stage.ok ? "PASS" : "FAIL"}`);
  for (const e of endpoints) {
    const flags = [e.p95 > e.target ? `p95>${e.target}` : "", e.status5xx ? `${e.status5xx}×5xx` : "", e.errors ? `${e.errors}×network` : "", e.status4xx > e.count * 0.01 ? `${e.status4xx}×4xx ${JSON.stringify(e.statuses)}` : ""].filter(Boolean).join(" ");
    console.log(`  ${e.ok ? "✓" : "✗"} ${e.name.padEnd(36)} ${String(e.count).padStart(6)}  ${String(e.rps).padStart(6)}/s  p50 ${String(e.p50).padStart(4)}  p95 ${String(e.p95).padStart(5)}  p99 ${String(e.p99).padStart(5)} ms ${flags}`);
  }
}
fs.mkdirSync("test-reports", { recursive: true });
const file = `test-reports/load-${report.runAt.slice(0, 16).replace(/[:T]/g, "-")}.json`;
fs.writeFileSync(file, JSON.stringify(report, null, 2));
fs.writeFileSync("test-reports/load-latest.json", JSON.stringify(report, null, 2));
console.log(`\nReport: ${file}`);
process.exit(report.stages.every((stage) => stage.ok) ? 0 : 1);
