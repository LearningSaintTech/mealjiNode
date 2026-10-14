// Step 14 · Meal Ji Plus: plans and buying — Home “Meal Ji Plus” banner, Choose
// plan, Plan details, Plan payment, Plan confirmed (“Welcome to Meal Ji Plus”),
// My Subscription. Demo customer 9000000036 buys a plan here (everything it
// creates is removed afterwards); 9000000031 already has Standard Monthly.
import mongoose from "mongoose";
import { Client, createSuite, db, DEMO, headOk } from "./harness.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rupees = (paise) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export default async function step14(ctx) {
  const s = createSuite("14", "Meal Ji Plus: plans and buying");
  const database = await db();
  const me = new Client("step14-device-001");
  await me.signIn("9000000036");
  const member = new Client("step14-device-002");
  await member.signIn(DEMO.customer);
  const userId = new mongoose.Types.ObjectId(me.session.user.userId);
  const startedAt = new Date();
  ctx.cleanups.push(async () => {
    const subs = await database.collection("subscriptions").find({ user: userId, createdAt: { $gte: startedAt } }).project({ _id: 1 }).toArray();
    const ids = subs.map((x) => x._id);
    const payments = await database.collection("payments").find({ refType: "subscription", refId: { $in: ids } }).project({ _id: 1 }).toArray();
    await database.collection("invoices").deleteMany({ refType: "subscription", refId: { $in: payments.map((p) => p._id) } });
    await database.collection("refunds").deleteMany({ payment: { $in: payments.map((p) => p._id) } });
    await database.collection("payments").deleteMany({ _id: { $in: payments.map((p) => p._id) } });
    await database.collection("subscriptions").deleteMany({ _id: { $in: ids } });
    await database.collection("users").updateOne({ _id: userId }, { $set: { "subscription.planCode": null, "subscription.status": "none", "subscription.subscribedAt": null, "subscription.expiresAt": null } });
    await database.collection("notifications").deleteMany({ user: userId, createdAt: { $gte: startedAt } });
  });

  // ---- Choose plan / Home banner
  const plans = (await me.call("GET", "/subscription-plans")).data || [];
  await s.run("14-01", "Plan cards as the app draws them", "Choose plan / Home banner: name, line, “₹3,499/Month”, “In Just 3499/- Monthly”, What you get, Select … Plan", async () => {
    const images = await Promise.all(plans.map((p) => headOk(p.imageUrl)));
    return {
      ok: plans.length >= 3 && plans.every((p) => p.name && p.subtitle && p.priceLabel === `${rupees(p.pricePaise)}/Month` && p.priceRupees === String(Math.round(p.pricePaise / 100)) && p.benefits.length >= 5 && p.ctaLabel === `Select ${p.name.replace(/ Monthly$/, "")} Plan`) && plans.filter((p) => p.isPopular).length === 1 && images.every(Boolean),
      detail: plans.map((p) => `${p.name} ${p.priceLabel}${p.badge ? ` [${p.badge}]` : ""} “${p.ctaLabel}”`).join(" · ") + ` · images ${images.filter(Boolean).length}/${images.length}`,
    };
  });
  const plan = plans.find((p) => p.planCode === "BASIC_MONTHLY") || plans[0];
  await s.run("14-02", "Plan details: What you get and Available Categories with pictures", "Plan details screen", async () => {
    const detail = (await me.call("GET", `/subscription-plans/${plan.planCode.toLowerCase()}`)).data || {};
    const unknown = await me.call("GET", "/subscription-plans/GOLD_YEARLY");
    const pictures = await Promise.all((detail.categories || []).map((c) => headOk(c.imageUrl)));
    return {
      ok: detail.planCode === plan.planCode && detail.benefits?.length >= 5 && detail.categories?.length >= 3 && detail.categories.every((c) => c.name) && pictures.every(Boolean) && unknown.status === 404,
      detail: `${detail.name}: ${detail.categories?.map((c) => c.name).join(", ")} · unknown plan ${unknown.status}`,
    };
  });

  // ---- Plan payment
  const address = ((await me.call("GET", "/users/me/addresses")).data || []).find((a) => a.isDefault) || ((await me.call("GET", "/users/me/addresses")).data || [])[0];
  let summary = null;
  await s.run("14-03", "Plan payment: address, total, start and billing dates, ways to pay", "Payment screen (Delivery Address, Cards, More payment options, total, Checkout)", async () => {
    const res = await me.call("GET", `/subscriptions/checkout/summary?planCode=${plan.planCode}&addressId=${address.addressId}`);
    summary = res.data || {};
    return {
      ok: res.status === 200 && summary.address?.fullAddress && summary.totalPaise === plan.pricePaise && summary.totalLabel === rupees(plan.pricePaise) && summary.billLines?.length >= 2 && summary.startDateLabel && summary.nextBillingDateLabel && summary.paymentOptions?.length >= 1 && Array.isArray(summary.savedMethods),
      detail: `${summary.address?.displayLabel}: ${summary.address?.fullAddress?.slice(0, 40)}… · ${summary.billLines?.map((l) => `${l.label} ${l.text || rupees(l.amountPaise)}`).join(" | ")} · total ${summary.totalLabel} · starts ${summary.startDateLabel}, next bill ${summary.nextBillingDateLabel} · ${summary.paymentOptions?.map((o) => o.label).join(" / ")}`,
    };
  });

  // ---- Buy and confirm
  let bought = null;
  await s.run("14-04", "Checkout and pay: Welcome to Meal Ji Plus with plan, dates and address", "Checkout → Plan confirmed", async () => {
    const homeBefore = (await me.call("GET", "/home")).data?.sections?.find((x) => x.type === "subscription_promo");
    const res = await me.call("POST", "/subscriptions/checkout", { planCode: plan.planCode, billingMethod: "link", addressId: address.addressId });
    const pay = await me.call("POST", "/payments/test/complete", { gatewayOrderId: res.data?.payment?.gatewayOrderId });
    await wait(500);
    bought = (await me.call("GET", "/subscriptions/me")).data?.subscription;
    const profile = (await me.call("GET", "/users/me")).data;
    const homeAfter = (await me.call("GET", "/home")).data?.sections?.find((x) => x.type === "subscription_promo");
    return {
      ok: res.status === 201 && pay.status === 200 && bought?.status === "active" && bought.statusLabel === "Active" && bought.planLabel === `${plan.name} (${rupees(plan.pricePaise)})` && bought.startDateLabel && bought.nextBillingDateLabel && bought.validTillLabel && bought.address?.fullAddress && profile?.subscription?.status === "active" && homeBefore?.isMember === false && homeAfter?.isMember === true && homeAfter.subscription?.planCode === plan.planCode,
      detail: `${bought?.statusLabel} · ${bought?.planLabel} · starts ${bought?.startDateLabel} · next bill ${bought?.nextBillingDateLabel} · valid till ${bought?.validTillLabel} · Home shows “${homeAfter?.subscription?.planName}”`,
    };
  });
  await s.run("14-05", "Buying again, other people's addresses, unknown plans and payment types are refused", "Checkout errors", async () => {
    const again = await me.call("POST", "/subscriptions/checkout", { planCode: plan.planCode, billingMethod: "link", addressId: address.addressId });
    const otherAddress = ((await member.call("GET", "/users/me/addresses")).data || [])[0];
    const fresh = new Client("step14-device-003");
    await fresh.signIn("9000000034");
    const foreign = await fresh.call("POST", "/subscriptions/checkout", { planCode: plan.planCode, billingMethod: "link", addressId: otherAddress.addressId });
    const unknown = await fresh.call("POST", "/subscriptions/checkout", { planCode: "GOLD_YEARLY", billingMethod: "link", addressId: otherAddress.addressId });
    const method = await fresh.call("POST", "/subscriptions/checkout", { planCode: plan.planCode, billingMethod: "cash", addressId: otherAddress.addressId });
    return {
      ok: again.status === 409 && /already/i.test(again.message) && foreign.status === 404 && unknown.status === 404 && method.status === 422 && method.message !== "Validation failed",
      detail: `again ${again.status} “${again.message}” · other's address ${foreign.status} · unknown plan ${unknown.status} · cash ${method.status} “${method.message}”`,
    };
  });
  await s.run("14-06", "Two taps on Checkout: one payment, one plan", "Checkout (double tap)", async () => {
    const buyer = new Client("step14-device-004");
    await buyer.signIn("9000000034");
    const buyerId = new mongoose.Types.ObjectId(buyer.session.user.userId);
    const addr = ((await buyer.call("GET", "/users/me/addresses")).data || [])[0];
    const since = new Date();
    ctx.cleanups.push(async () => {
      const subs = await database.collection("subscriptions").find({ user: buyerId, createdAt: { $gte: since } }).project({ _id: 1 }).toArray();
      const payments = await database.collection("payments").find({ refType: "subscription", refId: { $in: subs.map((x) => x._id) } }).project({ _id: 1 }).toArray();
      await database.collection("invoices").deleteMany({ refType: "subscription", refId: { $in: payments.map((p) => p._id) } });
      await database.collection("refunds").deleteMany({ payment: { $in: payments.map((p) => p._id) } });
      await database.collection("payments").deleteMany({ _id: { $in: payments.map((p) => p._id) } });
      await database.collection("subscriptions").deleteMany({ _id: { $in: subs.map((x) => x._id) } });
      await database.collection("users").updateOne({ _id: buyerId }, { $set: { "subscription.planCode": null, "subscription.status": "none", "subscription.subscribedAt": null, "subscription.expiresAt": null } });
    });
    const body = { planCode: plan.planCode, billingMethod: "link", addressId: addr.addressId };
    const [a, b] = await Promise.all([buyer.call("POST", "/subscriptions/checkout", body), buyer.call("POST", "/subscriptions/checkout", body)]);
    const orders = [a, b].map((r) => r.data?.payment?.gatewayOrderId).filter(Boolean);
    for (const gatewayOrderId of [...new Set(orders)]) await buyer.call("POST", "/payments/test/complete", { gatewayOrderId });
    await wait(800);
    const live = await database.collection("subscriptions").countDocuments({ user: buyerId, status: "active" });
    const refunds = await database.collection("refunds").countDocuments({ user: buyerId, createdAt: { $gte: since } });
    return { ok: live === 1 && (new Set(orders).size === 1 || refunds === new Set(orders).size - 1), detail: `taps ${a.status}/${b.status} · payment orders ${new Set(orders).size} · active plans ${live} · refunds ${refunds}` };
  });

  await s.run("14-09", "A late payment for a replaced checkout is refunded, not a second plan", "Checkout (left, started again, both paid)", async () => {
    const buyer = new Client("step14-device-005");
    await buyer.signIn("9000000032");
    const buyerId = new mongoose.Types.ObjectId(buyer.session.user.userId);
    const addr = ((await buyer.call("GET", "/users/me/addresses")).data || [])[0];
    const since = new Date();
    const body = { planCode: plan.planCode, billingMethod: "link", addressId: addr.addressId };
    const first = await buyer.call("POST", "/subscriptions/checkout", body);
    const second = await buyer.call("POST", "/subscriptions/checkout", body);
    const paySecond = await buyer.call("POST", "/payments/test/complete", { gatewayOrderId: second.data?.payment?.gatewayOrderId });
    const payFirst = await buyer.call("POST", "/payments/test/complete", { gatewayOrderId: first.data?.payment?.gatewayOrderId });
    await wait(800);
    const live = await database.collection("subscriptions").countDocuments({ user: buyerId, status: "active" });
    const refunds = await database.collection("refunds").find({ user: buyerId, createdAt: { $gte: since } }).toArray();
    // Remove this run's payments, refunds and plan (the earlier cleanup only sees plans it can find).
    const payments = await database.collection("payments").find({ user: buyerId, refType: "subscription", createdAt: { $gte: since } }).project({ _id: 1, refId: 1 }).toArray();
    await database.collection("invoices").deleteMany({ refType: "subscription", refId: { $in: payments.map((p) => p._id) } });
    await database.collection("refunds").deleteMany({ user: buyerId, createdAt: { $gte: since } });
    await database.collection("payments").deleteMany({ _id: { $in: payments.map((p) => p._id) } });
    await database.collection("subscriptions").deleteMany({ user: buyerId, createdAt: { $gte: since } });
    await database.collection("users").updateOne({ _id: buyerId }, { $set: { "subscription.planCode": null, "subscription.status": "none", "subscription.subscribedAt": null, "subscription.expiresAt": null } });
    return {
      ok: first.status === 201 && second.status === 201 && paySecond.status === 200 && payFirst.status === 200 && live === 1 && refunds.length === 1 && refunds[0].amountPaise === plan.pricePaise,
      detail: `checkouts ${first.status}/${second.status} · paid ${paySecond.status}/${payFirst.status} · active plans ${live} · refunds ${refunds.map((r) => `${rupees(r.amountPaise)} ${r.status}`).join(", ")}`,
    };
  });

  // ---- My Subscription
  await s.run("14-07", "My Subscription: plan, price per month, Active, Valid till", "My Subscription header", async () => {
    const sub = (await member.call("GET", "/subscriptions/me")).data?.subscription;
    return {
      ok: sub?.status === "active" && sub.statusLabel === "Active" && sub.priceLabel === `${rupees(sub.renewalPricePaise)} / month` && /^Valid till \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(sub.validTillText || "") && Number.isInteger(sub.daysLeft),
      detail: `${sub?.plan?.name} · ${sub?.priceLabel} · ${sub?.statusLabel} · ${sub?.validTillText} · ${sub?.daysLeft} days left`,
    };
  });
  await s.run("14-08", "Signed out and another customer's plan are refused", "Security", async () => {
    const anon = await new Client().call("GET", "/subscription-plans");
    const verify = await member.call("POST", `/subscriptions/${bought?.subscriptionId}/verify-payment`, { gatewayOrderId: "order_x", gatewayPaymentId: "pay_x", signature: "bad" });
    return { ok: anon.status === 401 && [404, 409].includes(verify.status), detail: `signed out ${anon.status} · verify another customer's plan ${verify.status}` };
  });
  return s;
}
