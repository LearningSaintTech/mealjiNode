// Step 12 · Rewards and referrals — Rewards tab (points card, Redeem Rewards,
// Earn More Points), Meal Ji points history (Recent Activity, This Month),
// redeeming a reward and using it at checkout, points from orders, ratings,
// referrals and birthdays.
// Demo customer 9000000039 is the main user (points, ledger, coupons and orders
// made here are put back afterwards); the referred friend is the temporary
// new customer 9000000099.
import mongoose from "mongoose";
import { Client, createSuite, db, DEMO, headOk, newCustomer } from "./harness.js";

const APP_ICONS = ["cart", "gift", "user", "star", "clock", "refresh", "wallet"];
const DATE_LABEL = /^(Today|Yesterday), \d{1,2}:\d{2} (AM|PM)$|^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await wait(400);
  }
};

export default async function step12(ctx) {
  const s = createSuite("12", "Rewards and referrals");
  const database = await db();
  const me = new Client("step12-device-001");
  await me.signIn("9000000039");
  const admin = new Client("step12-admin-001");
  await admin.signIn(DEMO.admin, { staff: true });
  const other = new Client("step12-device-002");
  await other.signIn(DEMO.otherCustomer);

  // ---- snapshot 39 so everything can be put back
  const userId = new mongoose.Types.ObjectId(me.session.user.userId);
  const startedAt = new Date();
  const userBefore = await database.collection("users").findOne({ _id: userId });
  const lotsBefore = await database.collection("rewardtransactions").find({ user: userId }).project({ remaining: 1 }).toArray();
  const made = [];
  const tempRewards = [];
  ctx.cleanups.push(async () => {
    for (const orderId of made) await admin.call("POST", `/admin/orders/${orderId}/cancel`, { reason: "Step 12 test clean-up", refund: "full" }).catch(() => {});
    await me.call("DELETE", "/cart");
    await wait(1500);
    await database.collection("rewardtransactions").deleteMany({ user: userId, createdAt: { $gte: startedAt } });
    for (const lot of lotsBefore) await database.collection("rewardtransactions").updateOne({ _id: lot._id }, { $set: { remaining: lot.remaining } });
    const redemptions = await database.collection("rewardredemptions").find({ user: userId, createdAt: { $gte: startedAt } }).toArray();
    await database.collection("coupons").deleteMany({ code: { $in: redemptions.map((r) => r.couponCode) } });
    await database.collection("rewardredemptions").deleteMany({ _id: { $in: redemptions.map((r) => r._id) } });
    for (const r of redemptions) await database.collection("rewards").updateOne({ _id: r.reward }, { $inc: { redeemedCount: -1 } });
    await database.collection("rewards").deleteMany({ _id: { $in: tempRewards } });
    await database.collection("referrals").deleteMany({ referrer: userId, createdAt: { $gte: startedAt } });
    await database.collection("notifications").deleteMany({ user: userId, createdAt: { $gte: startedAt } });
    await database.collection("users").updateOne({ _id: userId }, { $set: { pointsBalance: userBefore.pointsBalance || 0, lifetimePoints: userBefore.lifetimePoints || 0, tier: userBefore.tier ?? null, dob: userBefore.dob ?? null, birthdayRewardYear: userBefore.birthdayRewardYear ?? null } });
  });

  const dishes = (await me.call("GET", "/dishes?limit=100&veg=false")).data?.items || [];
  const papad = dishes.find((d) => d.name === "Masala Papad");
  const placeCod = async (client, list) => {
    // Each customer orders from the kitchen that delivers to them.
    const own = client === me ? papad : ((await client.call("GET", "/dishes?limit=100&veg=false")).data?.items || []).find((d) => d.name === "Masala Papad");
    await client.call("DELETE", "/cart");
    await client.call("POST", "/cart/items", { dishId: own.dishId, qty: 3 });
    const res = await client.call("POST", "/orders", { paymentMethod: "cod" });
    if (list && res.data?.order?.orderId) list.push(res.data.order.orderId);
    return res.data?.order;
  };
  const deliver = async (orderId) => {
    for (const status of ["accepted", "preparing", "ready", "dispatched", "delivered"]) await admin.call("PATCH", `/admin/orders/${orderId}/status`, { status, reason: "step 12 test" });
  };
  const balance = async (client = me) => (await client.call("GET", "/rewards/summary")).data?.points;

  // ---- Rewards tab
  const overview = await me.call("GET", "/rewards/overview");
  const o = overview.data || {};
  await s.run("12-01", "Rewards tab in one call: points card, rewards to redeem, ways to earn", "Rewards screen", () => ({
    ok: overview.status === 200 && Number.isInteger(o.points) && o.points === (userBefore.pointsBalance || 0) && typeof o.valuePaise === "number" && o.tier && Array.isArray(o.rewards) && o.rewards.length >= 4 && Array.isArray(o.earn) && o.earn.length === 4 && Number.isInteger(o.affordableCount),
    detail: `${o.points} pts (₹${(o.valuePaise || 0) / 100}) · ${o.tier} · ${o.rewards?.length} rewards · ${o.earn?.length} ways to earn · can redeem ${o.affordableCount}`,
  }));
  await s.run("12-02", "Earn More Points matches the screen and the points actually given", "Place an order +50 · Refer a friend +200 · Write a review +100 · Birthday +250", () => {
    const want = { order: ["Place an order", 50, "cart"], referral: ["Refer a friend", 200, "user"], review: ["Write a review", 100, "star"], birthday: ["Celebrate your birthday", 250, "gift"] };
    const rows = o.earn || [];
    return {
      ok: Object.entries(want).every(([key, [title, points, icon]]) => rows.some((r) => r.key === key && r.title === title && r.points === points && r.pointsLabel === `+${points}` && r.icon === icon && r.subtitle && /^mealji:\/\//.test(r.deepLink || ""))),
      detail: rows.map((r) => `${r.title} ${r.pointsLabel} (${r.icon}) “${r.subtitle}”`).join(" · "),
    };
  });
  await s.run("12-03", "Redeem Rewards cards: name, live image, points, Redeem enabled only when affordable", "Redeem Rewards row", async () => {
    const rows = o.rewards || [];
    const images = await Promise.all(rows.map((r) => headOk(r.imageUrl)));
    const fair = rows.every((r) => r.canRedeem === (o.points >= r.points) && (r.canRedeem ? r.pointsShort === 0 : r.pointsShort === r.points - o.points));
    const dishRewards = rows.filter((r) => r.kind === "dish");
    return {
      ok: rows.every((r) => r.rewardId && r.name && r.pointsLabel === `${r.points} pts`) && rows.filter((r) => r.kind === "dish").every((r) => r.dishName) && images.every(Boolean) && fair && dishRewards.length >= 4 && dishRewards.every((r) => r.dishId) && o.affordableCount === rows.filter((r) => r.canRedeem).length,
      detail: rows.map((r) => `${r.name} ${r.points}${r.canRedeem ? "" : ` (need ${r.pointsShort})`}`).join(" · ") + ` · images ${images.filter(Boolean).length}/${images.length}`,
    };
  });

  // ---- history
  await s.run("12-04", "Points history: balance, “enough points for N free rewards”, activity rows", "Meal Ji points screen", async () => {
    const h = (await me.call("GET", "/rewards/history?limit=10")).data || {};
    const rows = h.items || [];
    return {
      ok: h.points === o.points && h.updatedLabel && typeof h.message === "string" && h.affordableCount === o.affordableCount && rows.length > 0 && rows.every((r) => r.title && DATE_LABEL.test(r.dateLabel) && ["Earned", "Redeemed", "Expired", "Reversed", "Adjusted"].includes(r.typeLabel) && APP_ICONS.includes(r.icon) && r.pointsLabel === `${r.points > 0 ? "+" : "-"}${Math.abs(r.points)}`) && typeof h.hasMore === "boolean",
      detail: `“${h.message}” · ${h.updatedLabel} · ${rows.slice(0, 3).map((r) => `${r.title} ${r.dateLabel} ${r.pointsLabel} ${r.typeLabel} ${r.icon}`).join(" | ")}`,
    };
  });
  await s.run("12-05", "This Month filter and paging", "“This Month” dropdown, scroll for more", async () => {
    const h = (await me.call("GET", "/rewards/history?period=this_month&limit=50")).data || {};
    const all = (await me.call("GET", "/rewards/history?period=all&limit=2&page=1")).data || {};
    const p2 = (await me.call("GET", "/rewards/history?period=all&limit=2&page=2")).data || {};
    const bad = await me.call("GET", "/rewards/history?period=yesterday");
    const monthStart = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7)}-01T00:00:00+05:30`);
    return {
      ok: (h.periods || []).map((p) => p.label).join() === "This Month,Last Month,All time" && (h.items || []).every((r) => new Date(r.createdAt) >= monthStart) && all.items?.length === 2 && all.hasMore === (all.total > 2) && !p2.items?.some((r) => all.items.some((x) => x.transactionId === r.transactionId)) && bad.status === 422,
      detail: `periods ${(h.periods || []).map((p) => p.label).join("/")} · this month ${h.items?.length} · all ${all.total} · bad period ${bad.status}`,
    };
  });

  // ---- redeem
  const affordable = (o.rewards || []).filter((r) => r.canRedeem && r.kind === "dish").sort((a, b) => a.points - b.points)[0];
  let redeemed = null;
  await s.run("12-06", "Redeem: points go down once, a personal code is issued, history shows it", "Tap Redeem", async () => {
    const before = await balance();
    const res = await me.call("POST", `/rewards/${affordable.rewardId}/redeem`);
    redeemed = res.data;
    const after = await balance();
    const h = (await me.call("GET", "/rewards/history?limit=1")).data.items[0];
    const mine = (await me.call("GET", "/rewards/redemptions")).data || [];
    return {
      ok: res.status === 201 && /^RW[0-9A-F]{8}$/.test(redeemed?.couponCode || "") && redeemed.pointsLeft === before - affordable.points && after === before - affordable.points && h.typeLabel === "Redeemed" && h.title === affordable.name && h.icon === "gift" && h.points === -affordable.points && mine[0]?.couponCode === redeemed.couponCode && mine[0].status === "issued" && redeemed.howToUse,
      detail: `${affordable.name}: ${before} → ${after} · code ${redeemed?.couponCode} · “${redeemed?.howToUse}”`,
    };
  });
  await s.run("12-07", "Double tap on Redeem charges once", "Two taps on Redeem", async () => {
    // Enough points for two redemptions, so only the double-tap guard can stop the second.
    await admin.call("POST", "/admin/rewards/adjust", { userId: String(userId), points: 1000, reason: "Step 12 test points" });
    const before = await balance();
    const cheapest = (await me.call("GET", "/rewards/catalog")).data.filter((r) => r.canRedeem).sort((a, b) => a.points - b.points)[0];
    if (!cheapest) return { ok: false, detail: `nothing affordable at ${before} pts` };
    const [a, b] = await Promise.all([me.call("POST", `/rewards/${cheapest.rewardId}/redeem`), me.call("POST", `/rewards/${cheapest.rewardId}/redeem`)]);
    const after = await balance();
    return { ok: [a.status, b.status].sort().join() === "201,409" && after === before - cheapest.points, detail: `${cheapest.name} ${cheapest.points} pts · taps → ${a.status}/${b.status} · ${before} → ${after}` };
  });
  await s.run("12-08", "Refusals: not enough points, unknown, bad ID, another tier's reward", "Redeem errors", async () => {
    const pts = await balance();
    const dear = (await me.call("GET", "/rewards/catalog")).data.find((r) => r.points > pts);
    const poor = await me.call("POST", `/rewards/${dear.rewardId}/redeem`);
    const after = await balance();
    const unknown = await me.call("POST", "/rewards/6a0000000000000000000000/redeem");
    const badId = await me.call("POST", "/rewards/nope/redeem");
    const locked = await admin.call("POST", "/admin/rewards", { name: "Step 12 gold-only", points: 1, kind: "flat", value: 1000, tiers: ["Black Makhani"], isActive: true });
    if (locked.data?.rewardId) tempRewards.push(new mongoose.Types.ObjectId(locked.data.rewardId));
    const hidden = !(await me.call("GET", "/rewards/catalog")).data.some((r) => r.rewardId === locked.data?.rewardId);
    const tier = await me.call("POST", `/rewards/${locked.data?.rewardId}/redeem`);
    return {
      ok: poor.status === 409 && /not enough points/i.test(poor.message) && after === pts && unknown.status === 404 && badId.status === 422 && hidden && tier.status === 403,
      detail: `short ${poor.status} “${poor.message}” · unknown ${unknown.status} · bad ID ${badId.status} · other tier hidden ${hidden}, redeem ${tier.status}`,
    };
  });

  // ---- using the reward
  await s.run("12-09", "The reward shows in Offers for its owner only, and nobody else can use the code", "Offers / Apply coupon", async () => {
    await me.call("DELETE", "/cart");
    await me.call("POST", "/cart/items", { dishId: papad.dishId, qty: 3 });
    const offers = (await me.call("GET", "/promos/available")).data || [];
    const mine = offers.find((c) => c.code === redeemed?.couponCode);
    await other.call("DELETE", "/cart");
    await other.call("POST", "/cart/items", { dishId: papad.dishId, qty: 3 });
    const theirs = (await other.call("GET", "/promos/available")).data || [];
    const steal = await other.call("POST", "/cart/promo", { code: redeemed?.couponCode });
    await other.call("DELETE", "/cart");
    return { ok: mine?.isReward === true && mine.title === affordable.name && !theirs.some((c) => c.code === redeemed?.couponCode) && steal.status === 422, detail: `owner sees “${mine?.title}” (${mine?.label}) · other customer list ${theirs.some((c) => c.code === redeemed?.couponCode) ? "shows it" : "hidden"} · apply ${steal.status}` };
  });
  await s.run("12-10", "Free dish reward: applying it adds the dish and takes its price off", "Apply a free-dish reward at checkout", async () => {
    const res = await me.call("POST", "/cart/promo", { code: redeemed?.couponCode });
    const cart = (await me.call("GET", "/cart")).data || {};
    // The same dish from this customer's own kitchen.
    const rewardDish = dishes.find((d) => d.name === affordable.dishName);
    const line = (cart.items || []).find((l) => l.name === rewardDish?.name);
    const discount = cart.bill?.discountPaise ?? cart.coupon?.discountPaise;
    return {
      ok: res.status === 200 && line && cart.coupon?.valid && discount === rewardDish.pricePaise * (affordable.dishQty || 1),
      detail: `apply ${res.status} “${res.message}” · line ${line ? `${line.name} x${line.qty}` : "missing"} · discount ₹${(discount || 0) / 100} (dish ₹${rewardDish?.pricePaise / 100})`,
    };
  });

  // ---- earning
  let order = null;
  await s.run("12-11", "Delivered order earns +50, titled with the order number; rating earns +100", "Place an order / Write a review", async () => {
    await me.call("DELETE", "/cart");
    const before = await balance();
    order = await placeCod(me, made);
    await deliver(order.orderId);
    const row = (source) => async () => (await me.call("GET", "/rewards/history?limit=10")).data.items.find((r) => r.referenceId === order.orderId && r.source === source);
    const earned = await until(row("order"));
    await me.call("POST", `/orders/${order.orderId}/rating`, { foodRating: 5, deliveryRating: 5, tags: ["Delicious"] });
    const review = await until(row("review"));
    const after = await balance();
    // Inbox: “You Earned 50 Points!” · “Yay! You earned 50 points for your recent order. …” (Rewards tab, star icon).
    const note = await until(async () => ((await me.call("GET", "/notifications?category=rewards&limit=10")).data?.items || []).find((n) => n.title === "You Earned 50 Points!"));
    if (!note?.body?.startsWith("Yay! You earned 50 points for your recent order.") || note.icon !== "star") return { ok: false, detail: `inbox: ${note?.title} · ${note?.body} · ${note?.icon}` };
    return { ok: earned?.points === 50 && earned.title === `Order #${order.orderNumber}` && earned.icon === "cart" && review?.points === 100 && review.title === "Review reward" && review.icon === "star" && after === before + 150, detail: `${before} → ${after} · ${earned?.title} ${earned?.pointsLabel} · ${review?.title} ${review?.pointsLabel}` };
  });

  // ---- referrals
  const refs = await me.call("GET", "/referrals/me");
  await s.run("12-12", "My referral code, share text and stats", "Refer a friend", () => ({
    ok: refs.status === 200 && /^[A-Z0-9]{6,12}$/.test(refs.data?.code || "") && refs.data.shareLink?.includes(refs.data.code) && refs.data.shareText?.includes(refs.data.code) && refs.data.pointsPerReferral === 200 && refs.data.stats && Array.isArray(refs.data.referrals),
    detail: `${refs.data?.code} · “${refs.data?.shareText}” · ${JSON.stringify(refs.data?.stats)}`,
  }));
  await s.run("12-13", "A friend applies the code once; wrong, own and repeat codes are refused", "Enter a referral code", async () => {
    const friend = (await newCustomer(ctx, { reset: true })).client;
    const own = await me.call("POST", "/referrals/apply", { code: refs.data.code });
    const wrong = await friend.call("POST", "/referrals/apply", { code: "NOPE1234" });
    const short = await friend.call("POST", "/referrals/apply", { code: "AB" });
    const [a, b] = await Promise.all([friend.call("POST", "/referrals/apply", { code: refs.data.code.toLowerCase() }), friend.call("POST", "/referrals/apply", { code: refs.data.code })]);
    const again = await friend.call("POST", "/referrals/apply", { code: refs.data.code });
    const old = await other.call("POST", "/referrals/apply", { code: refs.data.code });
    ctx.cleanups.push(async () => {
      const u = await database.collection("users").findOne({ phoneNumber: DEMO.newCustomer });
      if (!u) return;
      const orders = await database.collection("orders").find({ user: u._id }).project({ _id: 1 }).toArray();
      await database.collection("referrals").deleteMany({ referee: u._id });
      await database.collection("rewardtransactions").deleteMany({ user: u._id });
      await database.collection("notifications").deleteMany({ user: u._id });
      await database.collection("carts").deleteMany({ user: u._id });
      await database.collection("orders").deleteMany({ _id: { $in: orders.map((x) => x._id) } });
    });
    return {
      ok: own.status === 409 && wrong.status === 404 && short.status === 422 && [a.status, b.status].sort().join() === "200,409" && again.status === 409 && old.status === 409,
      detail: `own ${own.status} · wrong ${wrong.status} · too short ${short.status} · two taps ${a.status}/${b.status} · again ${again.status} · existing customer ${old.status}`,
    };
  });
  await s.run("12-14", "Both get +200 after the friend's first delivered order", "Referral payout", async () => {
    const friend = ctx.newCustomer.client;
    const before = await balance();
    const friendBefore = await balance(friend);
    const pending = (await me.call("GET", "/referrals/me")).data.referrals.find((r) => r.status === "pending");
    await friend.call("PATCH", "/users/me", { name: "Step Twelve Friend" });
    await friend.call("POST", "/users/me/addresses", { label: "Home", houseFlat: "No. 7, 1st Floor", street: "5th Cross", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", latitude: 12.9346, longitude: 77.6311 });
    const first = await placeCod(friend);
    if (!first?.orderId) return { ok: false, detail: "friend could not place an order" };
    await deliver(first.orderId);
    // The friend gets +200 welcome bonus and +50 for the delivered order itself.
    const paid = await until(async () => (await balance(friend)) === friendBefore + 250 && (await balance()) === before + 200);
    const mine = (await me.call("GET", "/referrals/me")).data;
    const row = (await me.call("GET", "/rewards/history?limit=5")).data.items.find((r) => r.title === "Referral bonus");
    const theirs = (await friend.call("GET", "/rewards/history?limit=5")).data.items.find((r) => r.title === "Welcome bonus");
    return { ok: Boolean(pending) && paid && row?.icon === "user" && theirs?.points === 200 && mine.stats.converted >= 1 && mine.referrals.some((r) => r.status === "converted"), detail: `pending first ${Boolean(pending)} · me ${before} → ${await balance()} · friend ${friendBefore} → ${await balance(friend)} · stats ${JSON.stringify(mine.stats)}` };
  });

  // ---- birthday
  await s.run("12-15", "Birthday treat +250 once a year", "Celebrate your birthday", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(5);
    await me.call("PATCH", "/users/me", { dob: `1995-${today}` });
    const before = await balance();
    const { dailyLoyaltyRun } = await import("../../src/modules/rewards/rewards.service.js");
    await dailyLoyaltyRun();
    await dailyLoyaltyRun();
    const after = await balance();
    const row = (await me.call("GET", "/rewards/history?limit=3")).data.items.find((r) => r.title === "Birthday treat");
    return { ok: after === before + 250 && row?.icon === "gift", detail: `${before} → ${after} after two daily runs · “${row?.title}”` };
  });

  // ---- security and admin
  await s.run("12-16", "Signed out, other customers and admin-only routes are refused", "Security", async () => {
    const anon = await new Client().call("GET", "/rewards/overview");
    const adminOnly = await me.call("GET", "/admin/rewards/liability");
    const adjust = await me.call("POST", "/admin/rewards/adjust", { userId: String(userId), points: 9999, reason: "free points" });
    const liability = await admin.call("GET", "/admin/rewards/liability");
    const ledger = await admin.call("GET", `/admin/users/${userId}/points`);
    const referrals = await admin.call("GET", "/admin/referrals?status=converted");
    return {
      ok: anon.status === 401 && adminOnly.status === 403 && adjust.status === 403 && liability.status === 200 && ledger.status === 200 && ledger.data.items.length > 0 && referrals.status === 200,
      detail: `signed out ${anon.status} · customer → admin ${adminOnly.status}/${adjust.status} · admin liability ₹${(liability.data?.liabilityPaise || 0) / 100}, ledger ${ledger.data?.total}, referrals ${referrals.data?.total}`,
    };
  });
  await s.run("12-17", "Payment methods wallet card: points, “Updated …”, rewards message", "Meal ji wallet card", async () => {
    const wallet = (await me.call("GET", "/wallet")).data;
    const tab = (await me.call("GET", "/rewards/overview")).data;
    return { ok: wallet.points === tab.points && /^Updated /.test(wallet.updatedLabel) && wallet.rewardsMessage === tab.message && wallet.affordableCount === tab.affordableCount, detail: `${wallet.points} pts · ${wallet.updatedLabel} · “${wallet.rewardsMessage}”` };
  });
  return s;
}
