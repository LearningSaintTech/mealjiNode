// Step 11 · Notifications — Notifications screen (tabs, groups, unread, mark read),
// push device registration, order updates arriving in the inbox.
// Demo customer 9000000038; read flags changed here are put back afterwards.
import mongoose from "mongoose";
import { Client, createSuite, db, DEMO } from "./harness.js";

const APP_ICONS = ["box", "moto", "star", "gift", "crown", "heart", "megaphone"];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function step11(ctx) {
  const s = createSuite("11", "Notifications");
  const me = new Client("step11-device-001");
  await me.signIn("9000000038");
  const database = await db();
  const userId = new mongoose.Types.ObjectId(me.session.user.userId);
  const unreadBefore = (await database.collection("notifications").find({ user: userId, isRead: false }).project({ _id: 1 }).toArray()).map((row) => row._id);
  ctx.cleanups.push(() => database.collection("notifications").updateMany({ _id: { $in: unreadBefore } }, { $set: { isRead: false, readAt: null } }));

  const first = (await me.call("GET", "/notifications?limit=20")).data;
  await s.run("11-01", "Inbox rows as the screen draws them", "Groups Today / Yesterday / This Week / Earlier, “2m ago”, icon, unread dot", () => ({
    ok: first.items.length > 0 && first.items.every((n) => n.notificationId && n.title && ["Today", "Yesterday", "This Week", "Earlier"].includes(n.group) && n.timeLabel && APP_ICONS.includes(n.icon) && typeof n.isRead === "boolean"),
    detail: first.items.slice(0, 4).map((n) => `${n.group} · ${n.timeLabel} · ${n.icon} · ${n.title}`).join(" | "),
  }));
  await s.run("11-02", "Tabs with unread counts", "All / Orders / Offers / Rewards / Account", async () => {
    const tabs = first.tabs || [];
    const count = (await me.call("GET", "/notifications/unread-count")).data.unreadCount;
    const offers = (await me.call("GET", "/notifications?category=offers")).data;
    const bad = await me.call("GET", "/notifications?category=promos");
    const sum = tabs.filter((t) => t.key !== "all").reduce((n, t) => n + t.unreadCount, 0);
    return {
      ok: tabs.map((t) => t.label).join() === "All,Orders,Offers,Rewards,Account" && tabs[0].unreadCount === sum && count === sum && offers.items.every((n) => n.category === "offers") && offers.items.length > 0 && bad.status === 422,
      detail: `${tabs.map((t) => `${t.label} ${t.unreadCount}`).join(" · ")} · bell ${count} · bad tab ${bad.status}`,
    };
  });
  await s.run("11-03", "Paging", "Scroll for older notifications", async () => {
    const p1 = (await me.call("GET", "/notifications?limit=3&page=1")).data;
    const p2 = (await me.call("GET", "/notifications?limit=3&page=2")).data;
    return { ok: p1.items.length === 3 && typeof p1.hasMore === "boolean" && !p2.items.some((n) => p1.items.some((m) => m.notificationId === n.notificationId)), detail: `total ${p1.total}, hasMore ${p1.hasMore}` };
  });
  await s.run("11-04", "Open one: it is read and the bell goes down; others' are hidden", "Tap a notification", async () => {
    const unread = first.items.find((n) => !n.isRead);
    const before = (await me.call("GET", "/notifications/unread-count")).data.unreadCount;
    const res = await me.call("PATCH", `/notifications/${unread.notificationId}/read`);
    const other = new Client("step11-device-002");
    await other.signIn(DEMO.customer);
    const foreign = await other.call("PATCH", `/notifications/${unread.notificationId}/read`);
    return { ok: res.status === 200 && res.data.isRead && res.data.unreadCount === before - 1 && foreign.status === 404, detail: `${before} → ${res.data?.unreadCount} · other customer ${foreign.status}` };
  });
  await s.run("11-05", "Mark all as read", "“Mark all as read”", async () => {
    const res = await me.call("PATCH", "/notifications/read-all");
    const count = (await me.call("GET", "/notifications/unread-count")).data.unreadCount;
    return { ok: res.status === 200 && count === 0, detail: `unread now ${count}` };
  });
  await s.run("11-06", "Order updates arrive in the inbox with the order link and icon", "Order Confirmed / Out for Delivery notifications", async () => {
    const admin = new Client("step11-admin-001");
    await admin.signIn(DEMO.admin, { staff: true });
    await me.call("DELETE", "/cart");
    const papad = ((await me.call("GET", "/dishes?limit=100")).data.items || []).find((d) => d.name === "Masala Papad");
    await me.call("POST", "/cart/items", { dishId: papad.dishId, qty: 3 });
    const order = (await me.call("POST", "/orders", { paymentMethod: "cod" })).data.order;
    ctx.cleanups.push(() => admin.call("POST", `/admin/orders/${order.orderId}/cancel`, { reason: "Step 11 clean-up", refund: "full" }));
    for (const status of ["accepted", "preparing", "ready", "dispatched"]) await admin.call("PATCH", `/admin/orders/${order.orderId}/status`, { status, reason: "step 11 test" });
    let mine = [];
    for (let i = 0; i < 20 && mine.length < 2; i += 1) {
      await wait(1000); // order events reach the inbox through the outbox relay
      mine = (await me.call("GET", "/notifications?category=orders&limit=20")).data.items.filter((n) => n.deepLink?.url === `mealji://orders/${order.orderId}`);
    }
    const onTheWay = mine.find((n) => n.icon === "moto");
    ctx.cleanups.push(() => database.collection("notifications").updateMany({ user: userId, "deepLink.url": `mealji://orders/${order.orderId}` }, { $set: { isRead: true } }));
    return { ok: mine.length >= 2 && onTheWay && mine.every((n) => n.group === "Today"), detail: mine.map((n) => `${n.icon} ${n.title}`).join(" | ") || "none arrived" };
  });
  await s.run("11-07", "Demo numbers never get a real SMS", "Safety: demo accounts", async () => {
    const sms = await database.collection("messagelogs").countDocuments({ user: userId, channel: "sms", status: { $in: ["sent", "delivered"] } });
    return { ok: sms === 0, detail: `${sms} SMS sent to the demo customer` };
  });
  await s.run("11-08", "Push: register this phone, move the token, remove it", "App start / sign-in / log out", async () => {
    const token = `fcm-step11-${Date.now()}`;
    const reg = await me.call("POST", "/devices", { deviceId: "step11-device-001", fcmToken: token, platform: "android", appVersion: "1.0.0" });
    const other = new Client("step11-device-003");
    await other.signIn("9000000039");
    await other.call("POST", "/devices", { deviceId: "step11-device-003", fcmToken: token, platform: "android" });
    const mineRow = await database.collection("devicetokens").findOne({ user: userId, deviceId: "step11-device-001" });
    const bad = await me.call("POST", "/devices", { deviceId: "x", platform: "symbian" });
    const del = await me.call("DELETE", "/devices/step11-device-001");
    await other.call("DELETE", "/devices/step11-device-003");
    const gone = await database.collection("devicetokens").findOne({ user: userId, deviceId: "step11-device-001" });
    return { ok: reg.status === 200 && mineRow?.isValid === false && bad.status === 422 && del.status === 200 && !gone, detail: `registered ${reg.status} · same token on another account → old one ${mineRow?.isValid ? "still valid" : "switched off"} · bad ${bad.status} · removed ${del.status}` };
  });
  await s.run("11-09", "Push opens are tracked only for my messages", "Tap on a push", async () => {
    const log = await database.collection("messagelogs").findOne({ user: userId, messageId: { $ne: null } });
    const mine = log ? await me.call("POST", "/notifications/track", { messageId: log.messageId, event: "opened", channel: log.channel }) : null;
    const notMine = await me.call("POST", "/notifications/track", { messageId: "msg_not_mine_123", event: "opened" });
    return { ok: (!log || mine.status === 200) && notMine.status === 404, detail: `${log ? `own ${mine.status}` : "no message log yet"} · other ${notMine.status}` };
  });
  return s;
}
