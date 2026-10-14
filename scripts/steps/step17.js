// Step 17 · Account and analytics — Personal Information (change phone number
// with an OTP), data export and closing the account (no screen in the app yet;
// needed for the stores and DPDP), app analytics events and A/B experiments.
// Temporary customers 9000000095–97 are created here and removed afterwards.
import { Client, createSuite, db, DEMO, POINTS } from "./harness.js";

const TEMP = ["9000000095", "9000000096", "9000000097"];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function step17(ctx) {
  const s = createSuite("17", "Account and analytics");
  const database = await db();
  const startedAt = new Date();
  const removeTemp = async () => {
    const users = await database.collection("users").find({ phoneNumber: { $in: TEMP } }).project({ _id: 1 }).toArray();
    const ids = users.map((u) => u._id);
    const subs = await database.collection("subscriptions").find({ user: { $in: ids } }).project({ _id: 1 }).toArray();
    const payments = await database.collection("payments").find({ user: { $in: ids } }).project({ _id: 1 }).toArray();
    await database.collection("invoices").deleteMany({ refId: { $in: payments.map((p) => p._id) } });
    await database.collection("refunds").deleteMany({ user: { $in: ids } });
    await database.collection("payments").deleteMany({ user: { $in: ids } });
    await database.collection("mealselections").deleteMany({ subscription: { $in: subs.map((x) => x._id) } });
    await database.collection("subscriptions").deleteMany({ user: { $in: ids } });
    // Cancel through the admin API first so reserved stock is given back, then remove.
    const open = await database.collection("orders").find({ user: { $in: ids }, status: { $nin: ["cancelled", "delivered"] } }).project({ _id: 1 }).toArray();
    if (open.length) {
      const admin = new Client("step17-admin-cleanup");
      await admin.signIn(DEMO.admin, { staff: true });
      for (const order of open) await admin.call("POST", `/admin/orders/${order._id}/cancel`, { reason: "Step 17 test clean-up", refund: "full" }).catch(() => {});
    }
    await database.collection("orders").deleteMany({ user: { $in: ids } });
    for (const name of ["addresses", "notifications", "carts", "consents", "userstats", "devices", "refreshtokens"]) await database.collection(name).deleteMany({ user: { $in: ids } });
    await database.collection("users").deleteMany({ _id: { $in: ids } });
  };
  await removeTemp();
  ctx.cleanups.push(async () => {
    await removeTemp();
    await database.collection("analyticsevents").deleteMany({ anonymousId: { $regex: "^step17-" }, occurredAt: { $gte: new Date(startedAt.getTime() - 600_000) } });
  });

  // ---- Personal Information: change the phone number
  const me = new Client("step17-device-001");
  await me.signIn("9000000097");
  await me.call("PATCH", "/users/me", { name: "Step Seventeen" });
  await s.run("17-01", "New phone number: OTP sent to it; asking again at once must wait", "Personal Information → Phone Number → Save", async () => {
    const res = await me.call("POST", "/users/me/phone/otp", { phoneNumber: "+91 90000 00096" });
    const again = await me.call("POST", "/users/me/phone/otp", { phoneNumber: "9000000096" });
    return { ok: res.status === 200 && res.data.otpSent === true && res.data.phoneNumber === "9000000096" && res.data.resendAfterSec > 0 && again.status === 429, detail: `${res.status} to ${res.data?.phoneNumber}, resend after ${res.data?.resendAfterSec}s · again ${again.status} “${again.message}”` };
  });
  await s.run("17-02", "The same number or a wrong number format is refused with a clear message", "Phone Number field", async () => {
    const same = await me.call("POST", "/users/me/phone/otp", { phoneNumber: "9000000097" });
    const bad = await me.call("POST", "/users/me/phone/otp", { phoneNumber: "12345" });
    return { ok: same.status === 422 && same.message === "This is already your number" && bad.status === 422 && bad.message === "Enter a valid 10-digit mobile number", detail: `same ${same.status} “${same.message}” · bad ${bad.status} “${bad.message}”` };
  });
  await s.run("17-03", "Wrong code refused; right code changes the number and signs out; the new number signs in", "OTP screen for the new number", async () => {
    const wrong = await me.call("POST", "/users/me/phone/verify", { phoneNumber: "9000000096", otp: "000001" });
    const right = await me.call("POST", "/users/me/phone/verify", { phoneNumber: "9000000096", otp: process.env.FIXED_OTP || "123456" });
    const oldToken = await me.call("GET", "/users/me");
    const fresh = new Client("step17-device-002");
    const login = await fresh.signIn("9000000096");
    const profile = (await fresh.call("GET", "/users/me")).data;
    return {
      ok: wrong.status === 400 && right.status === 200 && right.data.signedOut === true && right.data.profile.phoneNumber === "9000000096" && oldToken.status === 401 && login.status === 201 && profile?.name === "Step Seventeen",
      detail: `wrong ${wrong.status} “${wrong.message}” · right ${right.status} “${right.message}” · old session ${oldToken.status} · new number sign-in ${login.status} as ${profile?.name}`,
    };
  });
  await s.run("17-04", "A number that belongs to another account cannot be taken", "Phone Number → someone else's number", async () => {
    const other = new Client("step17-device-003");
    await other.signIn("9000000095");
    const ask = await other.call("POST", "/users/me/phone/otp", { phoneNumber: DEMO.customer });
    const take = await other.call("POST", "/users/me/phone/verify", { phoneNumber: DEMO.customer, otp: process.env.FIXED_OTP || "123456" });
    const owner = await database.collection("users").countDocuments({ phoneNumber: DEMO.customer });
    return { ok: ask.status === 200 && take.status >= 400 && take.status < 500 && owner === 1, detail: `request ${ask.status} (same answer as a free number) · verify ${take.status} “${take.message}” · accounts with that number ${owner}` };
  });

  // ---- Data export (DPDP)
  await s.run("17-05", "Download my data: everything held about the customer, no secrets", "Account → Download my data", async () => {
    const member = new Client("step17-device-004");
    await member.signIn(DEMO.customer);
    const res = await member.call("GET", "/users/me/data-export");
    const d = res.data || {};
    const text = JSON.stringify(d);
    const keys = ["profile", "addresses", "orders", "subscriptions", "payments", "supportTickets", "points", "wallet", "favorites", "savedPaymentMethods", "notificationPreferences", "consents"];
    return {
      ok: res.status === 200 && keys.every((k) => k in d) && d.subscriptions.length >= 1 && d.orders.length >= 1 && d.points.balance >= 0 && !/gatewayTokenId|otp|refreshToken|passwordHash|sessionsRevokedAt/i.test(text),
      detail: `${keys.map((k) => `${k} ${Array.isArray(d[k]) ? d[k].length : d[k] ? "✓" : "–"}`).join(" · ")} · ${Math.round(text.length / 1024)} KB`,
    };
  });

  // ---- Close the account
  await s.run("17-06", "Close account with a Meal Ji Plus plan: plan and autopay stop, sign-in stops, restorable for 30 days", "Account → Delete account", async () => {
    const owner = new Client("step17-device-005");
    await owner.signIn("9000000095");
    const addr = await owner.call("POST", "/users/me/addresses", { label: "home", houseFlat: "Flat 17", street: "1st Main", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560095", latitude: POINTS.served.latitude, longitude: POINTS.served.longitude, recipientName: "Temp", phone: "9000000095" });
    const buy = await owner.call("POST", "/subscriptions/checkout", { planCode: "BASIC_MONTHLY", billingMethod: "link", addressId: addr.data?.addressId });
    await owner.call("POST", "/payments/test/complete", { gatewayOrderId: buy.data?.payment?.gatewayOrderId });
    await wait(500);
    await owner.call("PATCH", "/subscriptions/me/payment-method", { billingMethod: "autopay" });
    const closed = await owner.call("DELETE", "/users/me", { reason: "Testing" });
    const after = await owner.call("GET", "/users/me");
    const sub = await database.collection("subscriptions").findOne({ user: new (await import("mongoose")).default.Types.ObjectId(owner.session.user.userId) });
    const back = new Client("step17-device-006");
    const relogin = await back.signIn("9000000095");
    const plan = (await back.call("GET", "/subscriptions/me")).data;
    return {
      ok: buy.status === 201 && closed.status === 200 && closed.data.deleted === true && closed.data.planCancelled === true && /30 days/.test(closed.message) && after.status === 401 && sub.status === "cancel_scheduled" && sub.autoRenew === false && sub.billingMethod === "link" && !sub.gatewaySubscriptionId && relogin.status === 201 && plan.subscription?.status === "cancel_scheduled",
      detail: `plan bought ${buy.status} · closed ${closed.status} “${closed.message}” planCancelled ${closed.data?.planCancelled} · old session ${after.status} · plan ${sub?.status}, auto-renew ${sub?.autoRenew}, ${sub?.billingMethod} · sign-in again ${relogin.status} → plan ${plan?.subscription?.statusLabel}`,
    };
  });
  await s.run("17-10", "Closing the account waits while an order is on the way", "Account → Delete account (order in progress)", async () => {
    const buyer = new Client("step17-device-009");
    await buyer.signIn("9000000096");
    await buyer.call("POST", "/users/me/addresses", { label: "home", houseFlat: "Flat 96", street: "1st Main", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560095", latitude: POINTS.served.latitude, longitude: POINTS.served.longitude, recipientName: "Temp", phone: "9000000096" });
    const dishes = (await buyer.call("GET", "/dishes?limit=100")).data?.items || [];
    const dish = dishes.find((d) => d.name === "Masala Papad") || dishes.find((d) => !d.customizationGroups?.length);
    await buyer.call("DELETE", "/cart");
    await buyer.call("POST", "/cart/items", { dishId: dish?.dishId, qty: 3 });
    const placed = await buyer.call("POST", "/orders", { paymentMethod: "cod" });
    const closed = await buyer.call("DELETE", "/users/me", {});
    const still = await buyer.call("GET", "/users/me");
    return { ok: placed.status === 201 && closed.status === 409 && /order on the way/.test(closed.message) && still.status === 200, detail: `order ${placed.status} ${placed.data?.order?.statusLabel || placed.message} · close ${closed.status} “${closed.message}” · still signed in ${still.status}` };
  });
  await s.run("17-07", "Staff accounts are not closed from the app", "Security", async () => {
    const staff = new Client("step17-device-007");
    await staff.signIn(DEMO.admin, { staff: true });
    const res = await staff.call("DELETE", "/users/me", {});
    return { ok: res.status === 403, detail: `${res.status} “${res.message}”` };
  });

  // ---- Analytics and experiments
  await s.run("17-08", "App events: accepted in batches, duplicates and unknown events skipped, oversized ones refused", "App analytics (any screen)", async () => {
    const anon = new Client("step17-anon-device-1");
    const eventId = `step17-${Date.now()}`;
    const batch = { events: [{ name: "app_opened", eventId }, { name: "screen_viewed", properties: { screen: "Home" } }, { name: "not_a_real_event" }, { name: "screen_viewed" }] };
    const first = await anon.call("POST", "/analytics/events", batch, { headers: { "x-platform": "android", "x-app-version": "1.0.0" } });
    const dupe = await anon.call("POST", "/analytics/events", { events: [{ name: "app_opened", eventId }] });
    const tooMany = await anon.call("POST", "/analytics/events", { events: Array.from({ length: 51 }, () => ({ name: "app_opened" })) });
    const big = await anon.call("POST", "/analytics/events", { events: [{ name: "screen_viewed", properties: { screen: "Home", blob: "x".repeat(10_000) } }] });
    const stored = await database.collection("analyticsevents").countDocuments({ eventId });
    return {
      ok: first.status === 202 && first.data.accepted === 2 && first.data.rejected === 2 && first.data.errors.length === 2 && dupe.data?.accepted === 0 && stored === 1 && tooMany.status === 422 && big.status === 202 && big.data.accepted === 0 && /too large/i.test(big.data.errors?.[0]?.message || ""),
      detail: `batch ${first.status}: ${first.data?.accepted} in, ${first.data?.rejected} out (${first.data?.errors?.map((e) => e.message).join("; ")}) · repeat eventId ${dupe.data?.accepted} in, stored ${stored} · 51 events ${tooMany.status} · 10 KB properties: “${big.data?.errors?.[0]?.message}”`,
    };
  });
  await s.run("17-09", "Experiments: the signed-in customer's variants (same answer every time)", "App start (feature flags)", async () => {
    const member = new Client("step17-device-008");
    await member.signIn(DEMO.customer);
    const a = await member.call("GET", "/experiments/me");
    const b = await member.call("GET", "/experiments/me");
    const anon = await new Client().call("GET", "/experiments/me");
    return { ok: a.status === 200 && typeof a.data === "object" && !Array.isArray(a.data) && JSON.stringify(a.data) === JSON.stringify(b.data) && anon.status === 401, detail: `${a.status} ${JSON.stringify(a.data).slice(0, 80)} · same again ${JSON.stringify(a.data) === JSON.stringify(b.data)} · signed out ${anon.status}` };
  });
  await s.run("17-11", "After 30 days a closed account is anonymised everywhere (orders kept for tax with city, state, PIN only)", "Account → Delete account (30 days later)", async () => {
    const gone = new Client("step17-device-010");
    await gone.signIn("9000000097");
    const mongoose = (await import("mongoose")).default;
    const id = new mongoose.Types.ObjectId(gone.session.user.userId);
    await gone.call("PATCH", "/users/me", { name: "Purge Me", email: "purge.me@example.com" });
    await gone.call("POST", "/users/me/addresses", { label: "home", houseFlat: "Flat 97", street: "1st Main", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560095", latitude: POINTS.served.latitude, longitude: POINTS.served.longitude, recipientName: "Purge Me", phone: "9000000097" });
    const ticket = await gone.call("POST", "/support/tickets", { category: "account", issueType: (await gone.call("GET", "/support/categories")).data.find((c) => c.key === "account")?.issueTypes?.[0] || "Other", description: "My personal story in a ticket." });
    await database.collection("orders").insertOne({ user: id, orderNumber: `MJ-PURGE-${Date.now()}`, status: "delivered", customer: { name: "Purge Me", phone: "9000000097" }, address: { recipientName: "Purge Me", phone: "9000000097", houseFlat: "Flat 97", fullAddress: "Flat 97, Koramangala, Bengaluru", city: "Bengaluru", state: "Karnataka", pincode: "560095", latitude: 12.9, longitude: 77.6 }, items: [], createdAt: new Date(), updatedAt: new Date() });
    const closed = await gone.call("DELETE", "/users/me", {});
    await database.collection("users").updateOne({ _id: id }, { $set: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
    const { runTask } = await import("../../src/jobs/tasks.js");
    const purged = await runTask("account-purge");
    const user = await database.collection("users").findOne({ _id: id });
    const order = await database.collection("orders").findOne({ user: id });
    const t = await database.collection("supporttickets").findOne({ _id: new mongoose.Types.ObjectId(ticket.data?.ticketId) });
    const addresses = await database.collection("addresses").countDocuments({ user: id });
    const again = new Client("step17-device-011");
    const relogin = await again.signIn("9000000097");
    const isNew = again.session?.user?.userId && again.session.user.userId !== String(id);
    ctx.cleanups.push(async () => {
      await database.collection("orders").deleteMany({ user: id });
      await database.collection("supporttickets").deleteMany({ user: id });
      await database.collection("users").deleteMany({ _id: id });
    });
    return {
      ok: closed.status === 200 && purged >= 1 && user.purgedAt && user.name === "Deleted user" && user.phoneNumber.startsWith("deleted-") && !user.email && addresses === 0 && t?.description === "[removed]" && order.customer.name === "Deleted user" && order.address.fullAddress === null && order.address.houseFlat === null && order.address.latitude === null && order.address.pincode === "560095" && order.address.state === "Karnataka" && relogin.status === 201 && isNew,
      detail: `purged ${purged} · user “${user.name}”, ${user.phoneNumber} · addresses ${addresses} · ticket “${t?.description}” · order address “${order.address.fullAddress}” keeps ${order.address.city}, ${order.address.state} ${order.address.pincode} · the number signs in as a new account: ${Boolean(isNew)}`,
    };
  });
  return s;
}
