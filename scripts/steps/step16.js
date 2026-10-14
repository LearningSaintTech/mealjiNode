// Step 16 · Meal Ji Plus: manage — My Subscription menu: Plan Details, Change
// Plan, Billing History, Pause Subscription, Update Address, Cancel
// Subscription (reasons → Confirm Cancellation). Demo member 9000000033
// (Basic Monthly); the plan, its payments, invoices, addresses and
// notifications made here are put back afterwards.
import mongoose from "mongoose";
import { BASE, Client, createSuite, db, DEMO } from "./harness.js";

const LONG = /^\d{1,2} [A-Z][a-z]{2} \d{4}$/; // “28 Oct 2026”
const rupees = (paise) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export default async function step16(ctx) {
  const s = createSuite("16", "Meal Ji Plus: manage");
  const database = await db();
  const me = new Client("step16-device-001");
  await me.signIn("9000000033");
  const other = new Client("step16-device-002");
  await other.signIn(DEMO.customer);
  const admin = new Client("step16-admin-device-1");
  await admin.signIn(DEMO.admin, { staff: true });
  const userId = new mongoose.Types.ObjectId(me.session.user.userId);
  const original = await database.collection("subscriptions").findOne({ user: userId, status: "active" });
  const userBefore = await database.collection("users").findOne({ _id: userId }, { projection: { subscription: 1 } });
  const startedAt = new Date();
  ctx.cleanups.push(async () => {
    await database.collection("subscriptions").replaceOne({ _id: original._id }, original);
    await database.collection("users").updateOne({ _id: userId }, { $set: { subscription: userBefore.subscription } });
    const payments = await database.collection("payments").find({ refType: "subscription", refId: original._id, createdAt: { $gte: startedAt } }).project({ _id: 1 }).toArray();
    await database.collection("invoices").deleteMany({ refType: "subscription", refId: { $in: payments.map((p) => p._id) } });
    await database.collection("refunds").deleteMany({ payment: { $in: payments.map((p) => p._id) } });
    await database.collection("payments").deleteMany({ _id: { $in: payments.map((p) => p._id) } });
    await database.collection("addresses").deleteMany({ user: userId, createdAt: { $gte: startedAt } });
    await database.collection("notifications").deleteMany({ user: userId, createdAt: { $gte: startedAt } });
  });
  const mine = async () => (await me.call("GET", "/subscriptions/me")).data?.subscription;

  // ---- Plan Details
  await s.run("16-01", "Plan Details: next billing date, Auto-renewal on, what's included, change note", "Plan Details", async () => {
    const sub = await mine();
    return {
      ok: sub?.status === "active" && LONG.test(sub.nextBillingDateText || "") && sub.autoRenewLabel === "Auto-renewal on" && sub.plan.description && sub.plan.benefits.length >= 5 && sub.planChangeNote === "Any plan change starts from your next billing cycle." && sub.nextChargePaise === sub.renewalPricePaise,
      detail: `${sub?.plan?.name} · next billing ${sub?.nextBillingDateText} · ${sub?.autoRenewLabel} · “${sub?.plan?.description?.slice(0, 40)}…” · ${sub?.plan?.benefits?.length} included · “${sub?.planChangeNote}”`,
    };
  });

  // ---- Change Plan
  let target = null;
  await s.run("16-02", "Change Plan: plans with CURRENT, price per month, features and the start date", "Change Plan (Choose a plan that fits, CURRENT, ₹ / month, features, BEST VALUE, “Your new plan begins on … No charge today.”)", async () => {
    const res = await me.call("GET", "/subscriptions/me/change-plan");
    const list = res.data?.plans || [];
    target = list.find((p) => p.planCode === "STANDARD_MONTHLY");
    return {
      ok: res.status === 200 && list.length >= 3 && list.filter((p) => p.isCurrent).length === 1 && list.find((p) => p.isCurrent).planCode === original.planSnapshot.planCode && list.every((p) => p.priceText === `${rupees(p.pricePaise)} / month` && p.featuresLabel) && res.data.note === `Your new plan begins on ${res.data.effectiveOnText}. No charge today.` && res.data.keepLabel === `Keep ${original.planSnapshot.name.replace(/ Monthly$/, "")} Plan`,
      detail: `${list.map((p) => `${p.name}${p.isCurrent ? " [CURRENT]" : ""}${p.badge ? ` [${p.badge}]` : ""} ${p.priceText} “${p.featuresLabel}”`).join(" · ")} · “${res.data?.note}” · “${res.data?.keepLabel}”`,
    };
  });
  await s.run("16-03", "Choosing a plan: difference per month and “Continue with …”", "Change Plan footer (name • price, +₹, Continue with …)", async () => {
    const res = await me.call("GET", "/subscriptions/me/change-plan/preview?planCode=standard_monthly");
    const p = res.data || {};
    const diff = target.pricePaise - original.renewalPricePaise;
    return { ok: res.status === 200 && p.diffLabel === `+${rupees(diff)}` && p.continueLabel === "Continue with Standard" && p.summaryLabel === `${target.name} • ${target.priceText}` && LONG.test(p.effectiveOnText) && p.chargeTodayPaise === 0, detail: `${p.summaryLabel} · ${p.diffLabel} · “${p.continueLabel}” · from ${p.effectiveOnText} · “${p.note}”` };
  });
  await s.run("16-04", "Continue with Standard: change waits for the next cycle and the next bill uses the new price", "Change Plan → My Subscription", async () => {
    const res = await me.call("POST", "/subscriptions/me/change-plan", { planCode: "STANDARD_MONTHLY" });
    const sub = await mine();
    // The payment link for the next cycle (admin “resend link”) is for the new price.
    await admin.call("POST", `/admin/subscriptions/${original._id}/actions`, { action: "resend_link", reason: "step 16 test" });
    const link = await database.collection("payments").findOne({ refType: "subscription", refId: original._id, createdAt: { $gte: startedAt }, gatewayLinkId: { $ne: null } }, { sort: { createdAt: -1 } });
    return {
      ok: res.status === 200 && sub.plan.planCode === original.planSnapshot.planCode && sub.scheduledChange?.planName === "Standard Monthly" && LONG.test(sub.scheduledChange.effectiveOnText || "") && sub.scheduledChange.label === `Changes to Standard Monthly on ${sub.scheduledChange.effectiveOnText}` && sub.nextChargePaise === target.pricePaise && link?.amountPaise === target.pricePaise,
      detail: `${sub?.plan?.name} now · “${sub?.scheduledChange?.label}” · next charge ${rupees(sub?.nextChargePaise || 0)} · payment link ${link ? rupees(link.amountPaise) : "none"}`,
    };
  });
  await s.run("16-05", "Keep Basic Plan: choosing the current plan again drops the planned change", "Change Plan → Keep … Plan", async () => {
    const res = await me.call("POST", "/subscriptions/me/change-plan", { planCode: original.planSnapshot.planCode });
    const sub = await mine();
    const unknown = await me.call("POST", "/subscriptions/me/change-plan", { planCode: "GOLD_YEARLY" });
    return { ok: res.status === 200 && !sub.scheduledChange && sub.nextChargePaise === original.renewalPricePaise && unknown.status === 404, detail: `${res.status} “${res.message}” · planned change ${sub.scheduledChange ? "still there" : "gone"} · next charge ${rupees(sub.nextChargePaise)} · unknown plan ${unknown.status}` };
  });

  // ---- Pause
  await s.run("16-06", "Pause Subscription: 1–3 months with resume dates and button wording", "Pause Subscription (Take a break, not a goodbye; Pause for 1 month / Resume automatically on …; What happens while paused?)", async () => {
    const res = await me.call("GET", "/subscriptions/me/pause-options");
    const o = res.data || {};
    return {
      ok: res.status === 200 && o.options?.length === 3 && o.options.every((x, i) => x.title === `Pause for ${i + 1} month${i ? "s" : ""}` && x.buttonLabel === x.title && /^Resume automatically on \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(x.subtitle)) && o.title === "Take a break, not a goodbye" && o.whilePaused && o.subtitle,
      detail: `${o.options?.map((x) => `${x.title} (${x.subtitle})`).join(" · ")} · “${o.note}”`,
    };
  });
  await s.run("16-07", "Pause (two taps): scheduled once, shown on My Subscription; change plan still allowed", "Pause for 1 month", async () => {
    const [a, b] = await Promise.all([me.call("POST", "/subscriptions/me/pause", { months: 1 }), me.call("POST", "/subscriptions/me/pause", { months: 1 })]);
    const sub = await mine();
    const history = (await database.collection("subscriptions").findOne({ _id: original._id })).history.filter((h) => h.event === "pause_scheduled" && h.at >= startedAt);
    return { ok: [a.status, b.status].sort().join() === "200,409" && sub.status === "pause_scheduled" && /^Pauses on \d{1,2} [A-Z][a-z]{2} \d{4} · resumes \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(sub.pause?.label || "") && history.length === 1, detail: `taps ${a.status}/${b.status} · ${sub.statusLabel} · “${sub.pause?.label}” · pause entries ${history.length}` };
  });
  await s.run("16-08", "Autopay is paused with the plan and resumed with it", "Pause / resume with autopay", async () => {
    const auto = await me.call("PATCH", "/subscriptions/me/payment-method", { billingMethod: "autopay" });
    const afterSwitch = await database.collection("subscriptions").findOne({ _id: original._id });
    const resumed = await me.call("POST", "/subscriptions/me/resume");
    const paused = await me.call("POST", "/subscriptions/me/pause", { months: 1 });
    const whilePaused = await database.collection("subscriptions").findOne({ _id: original._id });
    const back = await me.call("POST", "/subscriptions/me/resume");
    const now = await database.collection("subscriptions").findOne({ _id: original._id });
    await me.call("PATCH", "/subscriptions/me/payment-method", { billingMethod: "link" });
    return { ok: auto.status === 200 && (original.billingMethod === "autopay" || Boolean(auto.data?.mandateUrl)) && afterSwitch.mandateStatus === "paused" && resumed.status === 200 && paused.status === 200 && whilePaused.mandateStatus === "paused" && back.status === 200 && back.data.status === "active" && now.mandateStatus === "active", detail: `calls ${auto.status}/${resumed.status}/${paused.status}/${back.status} “${[auto, resumed, paused, back].find((r) => r.status !== 200)?.message || ""}” · mandate link ${Boolean(auto.data?.mandateUrl)} · autopay on while pause scheduled → mandate ${afterSwitch.mandateStatus} · paused → ${whilePaused.mandateStatus} · resumed → ${now.mandateStatus}` };
  });

  // ---- Cancel
  let info = null;
  await s.run("16-09", "Cancel Subscription: the app's reasons, pause offer, and the Confirm Cancellation points", "Cancel Subscription + Confirm Cancellation (If you cancel now)", async () => {
    const res = await me.call("GET", "/subscriptions/me/cancel-reasons");
    info = res.data || {};
    const sub = await mine();
    return {
      ok: res.status === 200 && info.reasons?.length === 6 && info.reasons[0].label === "It’s too expensive" && info.reasons.at(-1).label === "Something else" && info.pauseOffer === "Pause for up to 3 months." && info.confirmTitle === `Cancel your ${original.planSnapshot.name.replace(/ Monthly$/, "")} Plan?` && info.points?.length === 3 && info.points[0] === `You can use your remaining meals until ${sub.validTillLabel}.` && info.points[1].startsWith("Auto-renewal stops and no payment will be taken on "),
      detail: `${info.reasons?.map((r) => r.label).join(" / ")} · “${info.pauseOffer}” · “${info.confirmTitle}” · ${info.points?.join(" | ")}`,
    };
  });
  await s.run("16-10", "Cancel subscription: ends on the paid-till day; plan changes and pausing are refused until undone", "Confirm Cancellation → Cancel subscription", async () => {
    const empty = await me.call("POST", "/subscriptions/me/cancel", {});
    const res = await me.call("POST", "/subscriptions/me/cancel", { reasonId: info.reasons[1].reasonId, comment: "Travelling" });
    const sub = await mine();
    const change = await me.call("POST", "/subscriptions/me/change-plan", { planCode: "PREMIUM_MONTHLY" });
    const pause = await me.call("POST", "/subscriptions/me/pause", { months: 1 });
    return {
      ok: empty.status === 422 && empty.message === "Choose a reason" && res.status === 200 && sub.status === "cancel_scheduled" && sub.statusLabel === `Ends on ${sub.validTillLabel}` && sub.autoRenewLabel === "Auto-renewal off" && sub.cancellation?.reason === info.reasons[1].label && change.status === 409 && /undo/i.test(change.message) && pause.status === 409,
      detail: `no reason ${empty.status} “${empty.message}” · ${sub.statusLabel} · ${sub.autoRenewLabel} · change plan ${change.status} “${change.message}” · pause ${pause.status} “${pause.message}”`,
    };
  });
  await s.run("16-11", "Keep my subscription after cancelling (undo)", "My Subscription → Keep my subscription", async () => {
    const res = await me.call("POST", "/subscriptions/me/cancel/undo");
    const again = await me.call("POST", "/subscriptions/me/cancel/undo");
    return { ok: res.status === 200 && res.data.status === "active" && res.data.autoRenewLabel === "Auto-renewal on" && again.status === 409, detail: `${res.data?.statusLabel} · ${res.data?.autoRenewLabel} · again ${again.status} “${again.message}”` };
  });

  // ---- Update Address
  await s.run("16-12", "Update Address: a saved address nearby is used for the next meals; too far or someone else's is refused", "Update Address (Changes apply to your next delivery)", async () => {
    const sub = await mine();
    const near = await me.call("POST", "/users/me/addresses", { label: "work", houseFlat: "2nd Floor, Step 16 Towers", street: "80 Feet Road", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", latitude: sub.address.latitude + 0.003, longitude: sub.address.longitude + 0.003, recipientName: "Test", phone: "9000000033" });
    const far = await me.call("POST", "/users/me/addresses", { label: "other", houseFlat: "Flat 1", street: "Connaught Place", locality: "CP", city: "New Delhi", state: "Delhi", pincode: "110001", latitude: 28.6315, longitude: 77.2167, recipientName: "Test", phone: "9000000033" });
    const res = await me.call("PATCH", "/subscriptions/me/address", { addressId: near.data?.addressId });
    const tooFar = await me.call("PATCH", "/subscriptions/me/address", { addressId: far.data?.addressId });
    const foreign = await me.call("PATCH", "/subscriptions/me/address", { addressId: ((await other.call("GET", "/users/me/addresses")).data || [])[0]?.addressId });
    const meal = await database.collection("mealselections").findOne({ subscription: original._id, status: { $in: ["open", "selected"] } });
    return {
      ok: near.status === 201 && res.status === 200 && res.data.address.addressId === near.data.addressId && res.data.addressNote === "Changes apply to your next delivery" && (!meal || meal.address.addressId === near.data.addressId) && tooFar.status === 409 && foreign.status === 404,
      detail: `${res.data?.address?.displayLabel}: ${res.data?.address?.fullAddress?.slice(0, 40)}… · “${res.data?.addressNote}” · too far ${tooFar.status} “${tooFar.message}” · someone else's ${foreign.status}`,
    };
  });

  // ---- Billing History
  await s.run("16-13", "Billing History: total paid, next payment, payment method, invoices with month and number", "Billing History (TOTAL PAID, NEXT PAYMENT, Recent invoices, PAID, payment method)", async () => {
    const res = await me.call("GET", "/subscriptions/me/invoices");
    const b = res.data || {};
    const first = b.items?.[0];
    return {
      ok: res.status === 200 && b.items?.length >= 1 && b.totalPaidLabel === rupees(b.totalPaidPaise) && b.totalPaidPaise >= first.totalPaise && /^\d{1,2} [A-Z][a-z]{2}$/.test(b.nextPaymentLabel || "") && b.paymentMethodLabel && /^[A-Z][a-z]+ \d{4}$/.test(first.monthLabel) && new RegExp(`^\\d{1,2} [A-Z][a-z]{2} \\d{4} • ${first.invoiceNumber.replace(/[/-]/g, "\\$&")}$`).test(first.dateLabel) && first.amountLabel === rupees(first.totalPaise) && first.statusLabel === "PAID" && first.pdfPath,
      detail: `paid ${b.totalPaidLabel} · next ${b.nextPaymentLabel} · ${b.paymentMethodLabel} · ${b.items?.map((i) => `${i.monthLabel} ${i.dateLabel} ${i.amountLabel} ${i.statusLabel}`).join(" | ")}`,
    };
  });
  await s.run("16-14", "Download a GST invoice; someone else's invoice is refused", "Billing History → download icon", async () => {
    const id = (await me.call("GET", "/subscriptions/me/invoices")).data.items[0].invoiceId;
    const pdf = await fetch(`${BASE}/subscriptions/me/invoices/${id}/pdf`, { headers: me.headers });
    const bytes = Buffer.from(await pdf.arrayBuffer());
    const theirs = await fetch(`${BASE}/subscriptions/me/invoices/${id}/pdf`, { headers: other.headers });
    return { ok: pdf.status === 200 && /pdf/.test(pdf.headers.get("content-type")) && bytes.subarray(0, 4).toString() === "%PDF" && theirs.status === 404, detail: `pdf ${pdf.status} ${bytes.length} bytes · someone else ${theirs.status}` };
  });
  // ---- Pause from tomorrow (kitchen setting) and charges while paused
  const istKey = (offset = 0) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const daysFrom = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
  await s.run("16-16", "Pause from tomorrow keeps the paid days: they are served after the pause", "Pause Subscription (kitchen pauses from the next day)", async () => {
    const kitchenId = String(original.kitchen);
    const set = await admin.call("PUT", "/admin/settings/subscription_policy", { scopeType: "kitchen", scopeId: kitchenId, values: { pauseStarts: "next_day" }, reason: "step 16 test" });
    ctx.cleanups.push(async () => {
      await database.collection("settings").deleteMany({ key: "subscription_policy", scopeType: "kitchen", scopeId: kitchenId, createdAt: { $gte: startedAt } });
      await new Promise((resolve) => setTimeout(resolve, 6000)); // resolved settings are cached for 5 s
    });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const before = await database.collection("subscriptions").findOne({ _id: original._id });
    const paused = await me.call("POST", "/subscriptions/me/pause", { months: 1 });
    const scheduled = await database.collection("subscriptions").findOne({ _id: original._id });
    const expectLeft = daysFrom(istKey(1), before.validTill) + 1;
    // Ten days later the pause has run (the daily job's work, done here directly), then the customer resumes.
    await database.collection("subscriptions").updateOne({ _id: original._id }, { $set: { status: "paused", "pause.startsOn": istKey(-10) } });
    const resumed = await me.call("POST", "/subscriptions/me/resume");
    const after = await database.collection("subscriptions").findOne({ _id: original._id });
    return {
      ok: set.status === 200 && paused.status === 200 && scheduled.pause.startsOn === istKey(1) && scheduled.validTill === before.validTill && scheduled.pause.daysLeft === expectLeft && resumed.status === 200 && after.status === "active" && after.validTill === istKey(expectLeft - 1) && after.nextBillingDate === istKey(expectLeft),
      detail: `setting ${set.status} · pause from ${scheduled.pause?.startsOn}, paid till stays ${scheduled.validTill}, ${scheduled.pause?.daysLeft} paid days kept · resumed today → meals till ${after.validTill}, next bill ${after.nextBillingDate}`,
    };
  });
  await s.run("16-17", "A renewal charged while paused is refunded and does not restart the plan", "Autopay charge during a pause", async () => {
    await database.collection("subscriptions").updateOne({ _id: original._id }, { $set: { status: "paused", pause: { startsOn: istKey(-3), resumesOn: istKey(27), months: 1, daysLeft: 0 } } });
    const sub = await database.collection("subscriptions").findOne({ _id: original._id });
    const gatewayOrderId = `order_test_step16_${Date.now()}`;
    await database.collection("payments").insertOne({ user: userId, refType: "subscription", refId: original._id, kitchen: original.kitchen, amountPaise: sub.renewalPricePaise, currency: "INR", method: "autopay", gateway: "test", gatewayOrderId, status: "created", cycle: sub.cycle + 1, refundedPaise: 0, createdAt: new Date(), updatedAt: new Date() });
    const pay = await me.call("POST", "/payments/test/complete", { gatewayOrderId });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = await database.collection("subscriptions").findOne({ _id: original._id });
    const payment = await database.collection("payments").findOne({ gatewayOrderId });
    const refund = await database.collection("refunds").findOne({ payment: payment._id });
    ctx.cleanups.push(() => database.collection("refunds").deleteMany({ payment: payment._id }));
    return { ok: pay.status === 200 && after.status === "paused" && after.cycle === sub.cycle && refund?.amountPaise === sub.renewalPricePaise, detail: `charge ${pay.status} · plan ${after.status}, cycle ${sub.cycle} → ${after.cycle} · refund ${refund ? `${rupees(refund.amountPaise)} ${refund.status}` : "none"}` };
  });

  await s.run("16-15", "Non-members and signed-out users are refused", "Security", async () => {
    const none = new Client("step16-device-003");
    await none.signIn("9000000038");
    const a = await none.call("GET", "/subscriptions/me/change-plan");
    const b = await none.call("POST", "/subscriptions/me/pause", { months: 1 });
    const c = await new Client().call("GET", "/subscriptions/me/invoices");
    const d = await me.call("POST", "/subscriptions/me/pause", { months: 9 });
    return { ok: a.status === 404 && b.status === 404 && c.status === 401 && d.status === 422, detail: `non-member ${a.status}/${b.status} “${a.message}” · signed out ${c.status} · 9 months ${d.status} “${d.message}”` };
  });
  // ---- Audit fixes: links, late payments and plan changes around renewal
  const fresh = () => database.collection("subscriptions").findOne({ _id: original._id });
  const payRow = async (row) => {
    const gatewayOrderId = `order_test_audit16_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await database.collection("payments").insertOne({ currency: "INR", gateway: "test", status: "created", refundedPaise: 0, createdAt: new Date(), updatedAt: new Date(), user: userId, refType: "subscription", refId: original._id, kitchen: original.kitchen, method: "link", ...row, gatewayOrderId });
    const res = await me.call("POST", "/payments/test/complete", { gatewayOrderId });
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { res, payment: await database.collection("payments").findOne({ gatewayOrderId }) };
  };
  const resetPlan = async () => {
    const { _id, ...rest } = original;
    await database.collection("subscriptions").replaceOne({ _id }, { _id, ...rest });
  };
  await s.run("16-18", "A link sent before a plan change is replaced: the old price can no longer be paid", "Change Plan after the renewal reminder", async () => {
    await resetPlan();
    await admin.call("POST", `/admin/subscriptions/${original._id}/actions`, { action: "resend_link", reason: "step 16 audit" });
    const oldLink = await database.collection("payments").findOne({ refId: original._id, gatewayLinkId: { $ne: null }, createdAt: { $gte: startedAt } }, { sort: { createdAt: -1 } });
    const change = await me.call("POST", "/subscriptions/me/change-plan", { planCode: "STANDARD_MONTHLY" });
    const after = await database.collection("payments").findOne({ _id: oldLink._id });
    const sub = await fresh();
    return { ok: change.status === 200 && after.status === "cancelled" && (!sub.paymentLink?.linkId || sub.paymentLink.amountPaise === target.pricePaise), detail: `old link ${rupees(oldLink.amountPaise)} → ${after.status} · plan change ${change.status} · current link ${sub.paymentLink?.amountPaise ? rupees(sub.paymentLink.amountPaise) : "none yet (sent on the due day)"}` };
  });
  await s.run("16-19", "Renewal paid at the old price: the plan change waits a cycle; the new period starts after the last served day", "Renewal with a planned change", async () => {
    const sub = await fresh();
    const { res, payment } = await payRow({ amountPaise: original.renewalPricePaise, cycle: sub.cycle + 1 });
    const after = await fresh();
    return {
      ok: res.status === 200 && payment.applyState === "done" && after.cycle === sub.cycle + 1 && after.planSnapshot.planCode === original.planSnapshot.planCode && after.scheduledChange?.planName === "Standard Monthly" && after.currentPeriodStart > sub.validTill,
      detail: `cycle ${sub.cycle} → ${after.cycle} · plan ${after.planSnapshot.name}, change to ${after.scheduledChange?.planName} still planned · new period ${after.currentPeriodStart}–${after.currentPeriodEnd} (was paid till ${sub.validTill})`,
    };
  });
  await s.run("16-20", "Cancelling closes open links; a renewal paid while the plan is ending is refunded", "Cancel Subscription → late link payment", async () => {
    await resetPlan();
    await admin.call("POST", `/admin/subscriptions/${original._id}/actions`, { action: "resend_link", reason: "step 16 audit" });
    const link = await database.collection("payments").findOne({ refId: original._id, gatewayLinkId: { $ne: null }, status: "created" }, { sort: { createdAt: -1 } });
    const cancel = await me.call("POST", "/subscriptions/me/cancel", { reasonId: "r1" });
    const closed = await database.collection("payments").findOne({ _id: link._id });
    const sub = await fresh();
    const { res, payment } = await payRow({ amountPaise: original.renewalPricePaise, cycle: sub.cycle + 1 });
    const after = await fresh();
    const refund = await database.collection("refunds").findOne({ payment: payment._id });
    return {
      ok: cancel.status === 200 && closed.status === "cancelled" && res.status === 200 && after.status === "cancel_scheduled" && after.cycle === sub.cycle && refund?.amountPaise === original.renewalPricePaise,
      detail: `link → ${closed.status} · late renewal ${res.status}: plan ${after.status}, cycle ${sub.cycle} → ${after.cycle}, refund ${refund ? rupees(refund.amountPaise) : "none"}`,
    };
  });
  await resetPlan();
  return s;
}
