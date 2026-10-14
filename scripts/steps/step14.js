// Step 14 · Meal Ji Plus: plans and buying — Home “Meal Ji Plus” banner, Choose
// plan, Plan details, Plan payment, Plan confirmed (“Welcome to Meal Ji Plus”),
// My Subscription. Demo customer 9000000036 buys a plan here (everything it
// creates is removed afterwards); 9000000031 already has Standard Monthly.
import mongoose from "mongoose";
import { Client, createSuite, db, DEMO, headOk, POINTS } from "./harness.js";

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
  // ---- Audit fixes: money is never kept without a plan or a refund
  const TEMP = ["9000000093", "9000000094"];
  const removeTemp = async () => {
    const ids = (await database.collection("users").find({ phoneNumber: { $in: TEMP } }).project({ _id: 1 }).toArray()).map((u) => u._id);
    const payments = await database.collection("payments").find({ user: { $in: ids } }).project({ _id: 1 }).toArray();
    await database.collection("invoices").deleteMany({ refId: { $in: payments.map((p) => p._id) } });
    await database.collection("refunds").deleteMany({ user: { $in: ids } });
    await database.collection("payments").deleteMany({ user: { $in: ids } });
    for (const name of ["subscriptions", "addresses", "notifications", "carts", "consents", "userstats", "devices", "refreshtokens"]) await database.collection(name).deleteMany({ user: { $in: ids } });
    await database.collection("users").deleteMany({ _id: { $in: ids } });
  };
  await removeTemp();
  ctx.cleanups.push(removeTemp);
  const buyerFor = async (phone, device, billingMethod = "link") => {
    const client = new Client(device);
    await client.signIn(phone);
    const addr = await client.call("POST", "/users/me/addresses", { label: "home", houseFlat: "Flat 14", street: "1st Main", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560095", latitude: POINTS.served.latitude, longitude: POINTS.served.longitude, recipientName: "Temp", phone });
    const res = await client.call("POST", "/subscriptions/checkout", { planCode: "BASIC_MONTHLY", billingMethod, addressId: addr.data?.addressId });
    return { client, userId: new mongoose.Types.ObjectId(client.session.user.userId), checkout: res };
  };
  // A payment the app completes for a payment row made here (the test gateway signs it).
  const payRow = async (client, row) => {
    const gatewayOrderId = `order_test_audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await database.collection("payments").insertOne({ currency: "INR", gateway: "test", status: "created", refundedPaise: 0, createdAt: new Date(), updatedAt: new Date(), ...row, gatewayOrderId });
    const res = await client.call("POST", "/payments/test/complete", { gatewayOrderId });
    await wait(400);
    return { res, payment: await database.collection("payments").findOne({ gatewayOrderId }) };
  };
  let auditBuyer = null;
  await s.run("14-10", "A captured payment whose plan was not started (crash) is finished on the retry", "Checkout → pay (server stopped half-way)", async () => {
    auditBuyer = await buyerFor("9000000094", "step14-audit-device-1");
    const gatewayOrderId = auditBuyer.checkout.data?.payment?.gatewayOrderId;
    // As if the server stopped right after recording the payment as captured.
    await database.collection("payments").updateOne({ gatewayOrderId }, { $set: { status: "captured", capturedAt: new Date(), gatewayPaymentId: "pay_test_crash", applyState: "pending" } });
    const before = await database.collection("subscriptions").findOne({ user: auditBuyer.userId });
    const retry = await auditBuyer.client.call("POST", "/payments/test/complete", { gatewayOrderId });
    await wait(400);
    const after = await database.collection("subscriptions").findOne({ user: auditBuyer.userId });
    const payment = await database.collection("payments").findOne({ gatewayOrderId });
    return { ok: before.status === "pending_payment" && retry.status === 200 && after.status === "active" && payment.applyState === "done" && String(after.lastPaymentId) === String(payment._id), detail: `before ${before.status} · retry ${retry.status} · plan ${after.status} · payment ${payment.applyState}` };
  });
  await s.run("14-11", "A second payment for a month already paid is refunded; the plan is unchanged", "Two payment links paid / link + autopay", async () => {
    const sub = await database.collection("subscriptions").findOne({ user: auditBuyer.userId });
    const { res, payment } = await payRow(auditBuyer.client, { user: auditBuyer.userId, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise: sub.renewalPricePaise, method: "link", cycle: 1 });
    const after = await database.collection("subscriptions").findOne({ _id: sub._id });
    const refund = await database.collection("refunds").findOne({ payment: payment._id });
    return { ok: res.status === 200 && after.cycle === 1 && String(after.lastPaymentId) === String(sub.lastPaymentId) && refund?.amountPaise === payment.amountPaise, detail: `paid ${res.status} · cycle ${after.cycle} · refund ${refund ? `${rupees(refund.amountPaise)} ${refund.status}` : "none"}` };
  });
  await s.run("14-12", "An autopay charge from a mandate the plan no longer uses is refunded", "Razorpay subscription.charged (old mandate)", async () => {
    const sub = await database.collection("subscriptions").findOne({ user: auditBuyer.userId });
    await database.collection("subscriptions").updateOne({ _id: sub._id }, { $set: { pastMandateIds: ["sub_test_old_mandate"] } });
    const event = { event: "subscription.charged", payload: { subscription: { entity: { id: "sub_test_old_mandate", status: "active", notes: {} } }, payment: { entity: { id: `pay_test_orphan_${Date.now()}`, amount: sub.renewalPricePaise, method: "upi" } } } };
    const signed = (await new Client().call("POST", "/webhooks/razorpay/test-sign", event)).data;
    const hook = await new Client().call("POST", "/webhooks/razorpay", signed.body, { raw: true, headers: { "x-razorpay-signature": signed.signature, "x-razorpay-event-id": `evt_test_${Date.now()}` } });
    await wait(400);
    const orphan = await database.collection("payments").findOne({ gatewayPaymentId: event.payload.payment.entity.id });
    const refund = orphan ? await database.collection("refunds").findOne({ payment: orphan._id }) : null;
    const after = await database.collection("subscriptions").findOne({ _id: sub._id });
    return { ok: hook.status === 200 && orphan?.orphanCharge === true && refund?.amountPaise === sub.renewalPricePaise && after.cycle === sub.cycle, detail: `webhook ${hook.status} · recorded ${Boolean(orphan)} (orphan ${orphan?.orphanCharge}) · refund ${refund ? rupees(refund.amountPaise) : "none"} · cycle ${sub.cycle} → ${after.cycle}` };
  });
  await s.run("14-13", "Autopay chosen at checkout: the approval link is shown until it is approved", "Payment (autopay) → Plan confirmed", async () => {
    const buyer = await buyerFor("9000000093", "step14-audit-device-2", "autopay");
    await buyer.client.call("POST", "/payments/test/complete", { gatewayOrderId: buyer.checkout.data?.payment?.gatewayOrderId });
    await wait(400);
    const sub = (await buyer.client.call("GET", "/subscriptions/me")).data?.subscription;
    return { ok: buyer.checkout.status === 201 && sub?.billingMethod === "autopay" && /^https?:\/\//.test(sub.mandateUrl || ""), detail: `${sub?.status} · ${sub?.billingMethod} · approve at ${sub?.mandateUrl}` };
  });
  return s;
}
