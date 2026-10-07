import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { addIstDays, istDateKey, istDateTime } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { cancelGatewaySubscription, createGatewayOrder, createGatewaySubscription, createPaymentLink, gatewayName } from "../../infrastructure/payments/gateway.js";
import { publish } from "../../realtime/hub.js";
import { Address, addressSnapshot } from "../address/address.model.js";
import { issueInvoice } from "../billing/billing.service.js";
import { Invoice } from "../billing/billing.model.js";
import { Payment } from "../payment/payment.model.js";
import { kitchenCovers, kitchenForPoint } from "../serviceability/serviceability.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { planSnapshot, plansForKitchen, toPlan } from "./plan.service.js";
import { Subscription, SubscriptionPlan } from "./subscription.model.js";
import { daysBetween, pauseDates } from "./subscription.rules.js";

const LIVE = ["active", "pause_scheduled", "paused", "cancel_scheduled", "past_due"];

// ------------------------------------------------------------------ views

export function toSubscription(sub) {
  const plan = sub.planSnapshot || {};
  const today = istDateKey();
  return {
    subscriptionId: String(sub._id),
    status: sub.status,
    plan: { planId: String(sub.plan), planCode: plan.planCode, name: plan.name, pricePaise: plan.pricePaise, cycleDays: plan.cycleDays, cycleLabel: plan.cycleLabel, slots: plan.slots, mealsPerDay: plan.mealsPerDay, maxItemsPerMeal: plan.maxItemsPerMeal, benefits: plan.benefits || [] },
    kitchenId: String(sub.kitchen),
    address: sub.address,
    billingMethod: sub.billingMethod,
    startDate: sub.startDate,
    cycle: sub.cycle,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    validTill: sub.validTill,
    nextBillingDate: sub.nextBillingDate,
    renewalPricePaise: sub.renewalPricePaise ?? plan.pricePaise,
    daysLeft: sub.validTill ? Math.max(0, daysBetween(today, sub.validTill) + 1) : null,
    autoRenew: sub.autoRenew,
    pause: sub.pause?.startsOn ? sub.pause : null,
    scheduledChange: sub.scheduledChange?.plan ? { planId: String(sub.scheduledChange.plan), planName: sub.scheduledChange.planName, effectiveOn: sub.scheduledChange.effectiveOn } : null,
    cancellation: sub.cancellation?.effectiveOn ? sub.cancellation : null,
    shiftsThisCycle: sub.shiftsThisCycle || 0,
    shiftsLeft: Math.max(0, (plan.maxShiftsPerCycle || 0) - (sub.shiftsThisCycle || 0)),
    paymentLink: sub.paymentLink?.url ? { url: sub.paymentLink.url, amountPaise: sub.paymentLink.amountPaise, cycle: sub.paymentLink.cycle } : null,
    pastDueSince: sub.pastDueSince,
    createdAt: sub.createdAt,
  };
}

function log(sub, event, note = null, by = "system") {
  sub.history.push({ at: new Date(), event, note, by });
}

async function syncUser(sub) {
  const plan = sub.planSnapshot || {};
  const status = { active: "active", pause_scheduled: "active", cancel_scheduled: "active", past_due: "active", paused: "paused", cancelled: "cancelled", expired: "expired", pending_payment: "none" }[sub.status] || "none";
  await User.updateOne({ _id: sub.user }, {
    $set: {
      "subscription.planCode": status === "none" ? null : plan.planCode,
      "subscription.status": status,
      "subscription.subscribedAt": sub.startDate ? istDateTime(sub.startDate) : null,
      "subscription.expiresAt": sub.validTill ? istDateTime(sub.validTill, "23:59") : null,
    },
  });
}

async function emit(name, sub, extra = {}) {
  await publishEventSafe(name, {
    subscriptionId: String(sub._id),
    userId: String(sub.user),
    kitchenId: String(sub.kitchen),
    planCode: sub.planSnapshot?.planCode,
    planName: sub.planSnapshot?.name,
    pricePaise: sub.renewalPricePaise ?? sub.planSnapshot?.pricePaise,
    ...extra,
  }, { aggregate: { type: "subscription", id: sub._id } });
  publish(`user:${sub.user}`, "subscription:updated", { subscriptionId: String(sub._id), status: sub.status });
}

export async function currentSubscription(userId) {
  return Subscription.findOne({ user: userId, status: { $in: LIVE } }).sort({ createdAt: -1 });
}

async function policyFor(sub) {
  return (await resolveSetting("subscription_policy", { kitchenId: sub.kitchen })).values;
}

// ------------------------------------------------------------------ checkout

/**
 * Starts a subscription: checks the plan is sold at the kitchen serving the
 * address, then creates a pending subscription and the first payment. With
 * autopay the mandate for later cycles is set up after the first payment.
 */
export async function checkout(userId, { planCode, billingMethod, addressId, startDate = null }) {
  if (await currentSubscription(userId)) throw new AppError(409, "You already have a MealJi Plus subscription");
  const plan = await SubscriptionPlan.findOne({ code: String(planCode).toUpperCase(), status: "active" }).lean();
  if (!plan) throw new AppError(404, "Plan not found");
  if (!plan.billingMethods.includes(billingMethod)) throw new AppError(422, `This plan is billed by ${plan.billingMethods.join(" or ")}`);
  const address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: userId, deletedAt: null }).lean();
  if (!address) throw new AppError(404, "Address not found");
  const match = await kitchenForPoint(address.latitude, address.longitude, { preferOpen: false });
  if (!match) throw new AppError(409, "We don't deliver MealJi Plus to this address yet");
  const available = await plansForKitchen(match.kitchen._id);
  if (!available.some((item) => item.planCode === plan.code)) throw new AppError(409, "This plan is not available at your address");
  const today = istDateKey();
  const start = startDate && startDate > today ? startDate : addIstDays(today, 1);
  if (daysBetween(today, start) > 30) throw new AppError(422, "Start within the next 30 days");

  await Subscription.deleteMany({ user: userId, status: "pending_payment" });
  const policy = (await resolveSetting("subscription_policy", { kitchenId: match.kitchen._id })).values;
  const sub = await Subscription.create({
    user: userId,
    plan: plan._id,
    planSnapshot: planSnapshot(plan),
    kitchen: match.kitchen._id,
    address: addressSnapshot(address),
    addressId: address._id,
    billingMethod,
    startDate: start,
    status: "pending_payment",
    renewalPricePaise: plan.pricePaise,
    expiresPaymentAt: new Date(Date.now() + policy.unpaidCheckoutExpiryHours * 3600_000),
    history: [{ at: new Date(), event: "checkout", by: "customer" }],
  });
  const user = await User.findById(userId).lean();
  const amountPaise = plan.pricePaise + (plan.deliveryIncluded ? 0 : plan.deliveryFeePaise || 0);
  const gateway = await createGatewayOrder({ amountPaise, receipt: `SUB-${String(sub._id).slice(-10)}`, notes: { subscriptionId: String(sub._id), cycle: 1 } });
  const payment = await Payment.create({ user: userId, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise, method: billingMethod, gateway: gateway.gateway, gatewayOrderId: gateway.gatewayOrderId, cycle: 1 });
  return {
    subscription: toSubscription(sub),
    payment: { paymentId: String(payment._id), gateway: gateway.gateway, keyId: gateway.keyId, gatewayOrderId: gateway.gatewayOrderId, amountPaise, currency: "INR", prefill: { name: user.name, contact: user.phoneNumber, email: user.email || null }, description: `MealJi Plus – ${plan.name}` },
  };
}

async function invoiceCycle(sub, payment) {
  try {
    const tax = (await resolveSetting("tax", { kitchenId: sub.kitchen })).values;
    const rate = Number(tax.foodGstPercent ?? 5);
    const taxable = Math.round((payment.amountPaise * 100) / (100 + rate));
    const gst = payment.amountPaise - taxable;
    const half = Math.floor(gst / 2);
    const user = await User.findById(sub.user).lean();
    const invoice = await issueInvoice({
      refType: "subscription",
      refId: payment._id,
      userId: sub.user,
      kitchenId: sub.kitchen,
      periodLabel: `${sub.currentPeriodStart} to ${sub.currentPeriodEnd}`,
      customer: { name: user?.name, phone: user?.phoneNumber, email: user?.email || null, address: sub.address?.fullAddress, state: sub.address?.state },
      lines: [{ description: `MealJi Plus ${sub.planSnapshot.name} (cycle ${sub.cycle})`, sac: tax.foodSac || "996331", qty: 1, unitPaise: taxable, taxablePaise: taxable, ratePercent: rate, cgstPaise: half, sgstPaise: gst - half, igstPaise: 0, totalPaise: payment.amountPaise }],
      totals: { taxablePaise: taxable, cgstPaise: half, sgstPaise: gst - half, igstPaise: 0, totalPaise: payment.amountPaise },
      placeOfSupply: sub.address?.state || null,
    });
    return invoice;
  } catch (err) {
    logger.error({ err: err.message, subscriptionId: String(sub._id) }, "Subscription invoice failed");
    return null;
  }
}

/** A captured subscription payment: first activation or a renewal cycle. */
export async function onSubscriptionPaymentCaptured(payment) {
  const sub = await Subscription.findById(payment.refId);
  if (!sub) return;
  const cycle = payment.cycle || sub.cycle + 1;
  if (cycle <= sub.cycle) return; // already applied
  const plan = sub.planSnapshot;
  if (cycle === 1) {
    const start = sub.startDate < istDateKey() ? istDateKey() : sub.startDate;
    sub.startDate = start;
    sub.currentPeriodStart = start;
    sub.currentPeriodEnd = addIstDays(start, plan.cycleDays - 1);
    sub.validTill = sub.currentPeriodEnd;
    sub.nextBillingDate = addIstDays(sub.currentPeriodEnd, 1);
    sub.status = "active";
    sub.cycle = 1;
    log(sub, "activated");
    if (sub.billingMethod === "autopay") {
      try {
        const user = await User.findById(sub.user).lean();
        const mandate = await createGatewaySubscription({ planAmountPaise: sub.renewalPricePaise, intervalDays: plan.cycleDays, notes: { subscriptionId: String(sub._id), planName: plan.name }, customer: { phone: user?.phoneNumber } });
        sub.gatewaySubscriptionId = mandate.gatewaySubscriptionId;
        sub.mandateStatus = mandate.status;
      } catch (err) {
        logger.warn({ err: err.message }, "Autopay mandate could not be created; falling back to payment links");
        sub.billingMethod = "link";
      }
    }
  } else {
    // Renewal: apply a scheduled plan change, carry shifted days forward.
    if (sub.scheduledChange?.plan) {
      const next = await SubscriptionPlan.findById(sub.scheduledChange.plan).lean();
      if (next) {
        sub.plan = next._id;
        sub.planSnapshot = planSnapshot(next);
        sub.renewalPricePaise = next.pricePaise;
        log(sub, "plan_changed", next.name);
        await emit("subscription.plan_changed", sub);
      }
      sub.scheduledChange = undefined;
    }
    const carry = sub.validTill && sub.currentPeriodEnd ? Math.max(0, daysBetween(sub.currentPeriodEnd, sub.validTill)) : 0;
    const start = sub.nextBillingDate && sub.nextBillingDate > istDateKey() ? sub.nextBillingDate : (sub.status === "paused" || sub.status === "past_due" ? istDateKey() : sub.nextBillingDate);
    sub.currentPeriodStart = start;
    sub.currentPeriodEnd = addIstDays(start, sub.planSnapshot.cycleDays - 1);
    sub.validTill = addIstDays(sub.currentPeriodEnd, carry);
    sub.nextBillingDate = addIstDays(sub.currentPeriodEnd, 1);
    sub.cycle = cycle;
    sub.status = sub.status === "cancel_scheduled" ? "cancel_scheduled" : "active";
    sub.pastDueSince = null;
    sub.renewalAttempts = 0;
    sub.shiftsThisCycle = 0;
    sub.autoShiftsThisCycle = 0;
    sub.paymentLink = undefined;
    sub.remindersSent = [];
    log(sub, "renewed", `cycle ${cycle}`);
  }
  await sub.save();
  await syncUser(sub);
  await invoiceCycle(sub, payment);
  await emit(cycle === 1 ? "subscription.activated" : "subscription.renewed", sub, { cycle, amountPaise: payment.amountPaise });
}

export async function onSubscriptionPaymentFailed(payment, reason) {
  const sub = await Subscription.findById(payment.refId);
  if (!sub || sub.status === "pending_payment") return;
  sub.renewalAttempts += 1;
  log(sub, "renewal_failed", reason);
  await sub.save();
  await emit("subscription.renewal_failed", sub, { reason });
  // Autopay failed: fall back to a payment link for this cycle.
  if (sub.billingMethod === "autopay") await sendPaymentLink(sub, { reason: "autopay_failed" }).catch(() => {});
}

/** Razorpay subscription and payment-link webhooks. */
export async function onSubscriptionWebhook(body) {
  const { onPaymentCaptured } = await import("../payment/payment.service.js");
  if (body.event === "payment_link.paid") {
    const linkId = body.payload?.payment_link?.entity?.id;
    const payment = await Payment.findOne({ gatewayLinkId: linkId });
    if (!payment) return "ignored";
    await onPaymentCaptured(payment, { gatewayPaymentId: body.payload?.payment?.entity?.id, method: body.payload?.payment?.entity?.method || "link" });
    return "processed";
  }
  const entity = body.payload?.subscription?.entity;
  const sub = entity ? await Subscription.findOne({ gatewaySubscriptionId: entity.id }) : null;
  if (!sub) return "ignored";
  if (body.event === "subscription.charged") {
    const paymentEntity = body.payload?.payment?.entity;
    const existing = await Payment.findOne({ gatewayPaymentId: paymentEntity?.id });
    if (existing) return "ignored";
    const payment = await Payment.create({ user: sub.user, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise: paymentEntity?.amount || sub.renewalPricePaise, method: "autopay", gateway: "razorpay", gatewaySubscriptionId: sub.gatewaySubscriptionId, cycle: sub.cycle + 1 });
    await onPaymentCaptured(payment, { gatewayPaymentId: paymentEntity?.id, method: paymentEntity?.method || "autopay" });
    return "processed";
  }
  if (body.event === "subscription.halted" || body.event === "subscription.cancelled") {
    sub.mandateStatus = entity.status;
    if (sub.billingMethod === "autopay") {
      sub.billingMethod = "link";
      log(sub, "autopay_stopped", body.event);
    }
    await sub.save();
    return "processed";
  }
  if (body.event === "subscription.activated") {
    sub.mandateStatus = "active";
    await sub.save();
    return "processed";
  }
  return "ignored";
}

/** Creates (or re-sends) the payment link for the next cycle. */
export async function sendPaymentLink(sub, { reason = "cycle" } = {}) {
  const cycle = sub.cycle + 1;
  const amountPaise = sub.renewalPricePaise ?? sub.planSnapshot.pricePaise;
  if (!sub.paymentLink?.linkId || sub.paymentLink.cycle !== cycle) {
    const user = await User.findById(sub.user).lean();
    const link = await createPaymentLink({
      amountPaise,
      description: `MealJi Plus ${sub.planSnapshot.name} – cycle ${cycle}`,
      reference: `SUB-${String(sub._id).slice(-8)}-${cycle}`,
      customer: { name: user?.name, phone: user?.phoneNumber, email: user?.email || null },
      expireBy: istDateTime(addIstDays(sub.nextBillingDate || istDateKey(), (await policyFor(sub)).graceDays), "23:59"),
      notes: { subscriptionId: String(sub._id), cycle },
    });
    await Payment.create({ user: sub.user, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise, method: "link", gateway: gatewayName(), gatewayLinkId: link.gatewayLinkId, cycle });
    sub.paymentLink = { url: link.shortUrl, linkId: link.gatewayLinkId, amountPaise, cycle, sentAt: new Date() };
    log(sub, "payment_link_created", reason);
    await sub.save();
  }
  await emit("subscription.payment_link", sub, { paymentUrl: sub.paymentLink.url, amountPaise, reason });
  return sub.paymentLink;
}

// ------------------------------------------------------------------ customer actions

async function requireOwn(userId) {
  const sub = await currentSubscription(userId);
  if (!sub) throw new AppError(404, "You don't have an active MealJi Plus subscription");
  return sub;
}

export async function mySubscription(userId) {
  const sub = await currentSubscription(userId);
  if (!sub) {
    const last = await Subscription.findOne({ user: userId, status: { $in: ["cancelled", "expired"] } }).sort({ updatedAt: -1 }).lean();
    return { subscription: null, lastSubscription: last ? toSubscription(last) : null };
  }
  return { subscription: toSubscription(sub) };
}

export async function subscriptionCard(userId) {
  const sub = await currentSubscription(userId);
  if (!sub) return null;
  const view = toSubscription(sub);
  return { subscriptionId: view.subscriptionId, status: view.status, planName: view.plan.name, validTill: view.validTill, daysLeft: view.daysLeft, slots: view.plan.slots };
}

export async function pauseOptions(userId) {
  const sub = await requireOwn(userId);
  const policy = await policyFor(sub);
  const options = [];
  for (let months = policy.pauseMinMonths; months <= policy.pauseMaxMonths; months += 1) {
    options.push({ months, ...pauseDates({ months, startsMode: policy.pauseStarts, currentPeriodEnd: sub.currentPeriodEnd, today: istDateKey() }) });
  }
  return { options, startsAt: policy.pauseStarts, note: policy.pauseStarts === "cycle_end" ? `The pause starts after ${sub.currentPeriodEnd}. You are not charged while paused.` : "The pause starts tomorrow." };
}

/** Pause choices for one subscription (admin acting on behalf). */
export async function pauseOptionsFor(subscriptionId) {
  const sub = await Subscription.findById(objectId(subscriptionId, "subscription ID"));
  if (!sub) throw new AppError(404, "Subscription not found");
  const policy = await policyFor(sub);
  const options = [];
  for (let months = policy.pauseMinMonths; months <= policy.pauseMaxMonths; months += 1) {
    options.push({ months, ...pauseDates({ months, startsMode: policy.pauseStarts, currentPeriodEnd: sub.currentPeriodEnd, today: istDateKey() }) });
  }
  return { options, startsAt: policy.pauseStarts };
}

export async function pause(userId, { months }, by = "customer") {
  const sub = typeof userId === "object" ? userId : await requireOwn(userId);
  if (sub.status !== "active") throw new AppError(409, "Only an active subscription can be paused");
  const policy = await policyFor(sub);
  if (!Number.isInteger(months) || months < policy.pauseMinMonths || months > policy.pauseMaxMonths) throw new AppError(422, `Pause for ${policy.pauseMinMonths} to ${policy.pauseMaxMonths} month(s)`);
  const dates = pauseDates({ months, startsMode: policy.pauseStarts, currentPeriodEnd: sub.currentPeriodEnd, today: istDateKey() });
  sub.pause = { ...dates, months, requestedAt: new Date() };
  sub.status = "pause_scheduled";
  if (policy.pauseStarts === "next_day") sub.validTill = addIstDays(dates.startsOn, -1);
  log(sub, "pause_scheduled", `${dates.startsOn} to ${dates.resumesOn}`, by);
  await sub.save();
  await syncUser(sub);
  await emit("subscription.pause_scheduled", sub, { resumesOn: dates.resumesOn });
  return toSubscription(sub);
}

export async function resume(userId, by = "customer") {
  const sub = typeof userId === "object" ? userId : await requireOwn(userId);
  if (!["pause_scheduled", "paused"].includes(sub.status)) throw new AppError(409, "This subscription is not paused");
  const wasPaused = sub.status === "paused";
  sub.pause = undefined;
  sub.status = "active";
  if (wasPaused) {
    // Resume now: bill a new cycle starting today.
    sub.nextBillingDate = istDateKey();
  }
  log(sub, "resumed", null, by);
  await sub.save();
  await syncUser(sub);
  await emit("subscription.resumed", sub);
  return toSubscription(sub);
}

export async function cancelReasons() {
  const policy = (await resolveSetting("subscription_policy")).values;
  return policy.cancelReasons.map((label, index) => ({ reasonId: `r${index + 1}`, label }));
}

export async function cancel(userId, { reasonId, comment }, by = "customer") {
  const sub = typeof userId === "object" ? userId : await requireOwn(userId);
  if (!["active", "pause_scheduled", "paused", "past_due"].includes(sub.status)) throw new AppError(409, "This subscription cannot be cancelled now");
  const reasons = await cancelReasons();
  const reason = reasons.find((item) => item.reasonId === reasonId);
  if (!reason && by === "customer") throw new AppError(422, "Choose a reason");
  sub.cancellation = { reasonId: reasonId || null, reason: reason?.label || null, comment: comment ? String(comment).slice(0, 500) : null, effectiveOn: sub.validTill || istDateKey(), requestedAt: new Date() };
  sub.status = "cancel_scheduled";
  sub.autoRenew = false;
  sub.pause = undefined;
  sub.scheduledChange = undefined;
  log(sub, "cancel_scheduled", reason?.label, by);
  await sub.save();
  if (sub.gatewaySubscriptionId) await cancelGatewaySubscription(sub.gatewaySubscriptionId).catch(() => {});
  await syncUser(sub);
  await emit("subscription.cancel_scheduled", sub, { reasonId, reason: reason?.label || null, validTill: sub.validTill });
  return toSubscription(sub);
}

export async function undoCancel(userId) {
  const sub = await requireOwn(userId);
  if (sub.status !== "cancel_scheduled") throw new AppError(409, "Nothing to undo");
  if (!(await policyFor(sub)).allowCancelUndo) throw new AppError(403, "Cancellations cannot be undone");
  sub.status = "active";
  sub.autoRenew = true;
  sub.cancellation = undefined;
  log(sub, "cancel_undone", null, "customer");
  await sub.save();
  if (sub.billingMethod === "autopay" && sub.gatewaySubscriptionId) {
    // The old mandate was cancelled; renewals continue by payment link until a new mandate is set up.
    sub.billingMethod = "link";
    await sub.save();
  }
  await syncUser(sub);
  await emit("subscription.cancel_undone", sub);
  return toSubscription(sub);
}

export async function changePlanPreview(userId, planCode) {
  const sub = await requireOwn(userId);
  const next = await SubscriptionPlan.findOne({ code: String(planCode).toUpperCase(), status: "active" }).lean();
  if (!next) throw new AppError(404, "Plan not found");
  if (String(next._id) === String(sub.plan)) throw new AppError(409, "You are already on this plan");
  const available = await plansForKitchen(sub.kitchen);
  if (!available.some((plan) => plan.planCode === next.code)) throw new AppError(409, "This plan is not available at your address");
  const policy = await policyFor(sub);
  return {
    current: toSubscription(sub).plan,
    next: toPlan(next),
    effectiveOn: policy.planChangeTiming === "immediately" ? istDateKey() : sub.nextBillingDate,
    chargeTodayPaise: 0,
    nextChargePaise: next.pricePaise,
    note: policy.planChangeTiming === "immediately" ? "Your plan changes today; the new price applies from your next bill." : `Your plan changes on ${sub.nextBillingDate}. No charge today.`,
  };
}

export async function changePlan(userId, planCode) {
  const preview = await changePlanPreview(userId, planCode);
  const sub = await requireOwn(userId);
  const next = await SubscriptionPlan.findById(preview.next.planId).lean();
  if (preview.effectiveOn === istDateKey()) {
    sub.plan = next._id;
    sub.planSnapshot = planSnapshot(next);
    sub.renewalPricePaise = next.pricePaise;
    log(sub, "plan_changed", next.name, "customer");
  } else {
    sub.scheduledChange = { plan: next._id, planName: next.name, effectiveOn: preview.effectiveOn };
    log(sub, "plan_change_scheduled", next.name, "customer");
  }
  await sub.save();
  await emit("subscription.plan_change_scheduled", sub, { nextPlanName: next.name, effectiveOn: preview.effectiveOn });
  return toSubscription(sub);
}

export async function updateAddress(userId, addressId) {
  const sub = await requireOwn(userId);
  const address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: userId, deletedAt: null }).lean();
  if (!address) throw new AppError(404, "Address not found");
  const { Kitchen } = await import("../kitchen/kitchen.model.js");
  const kitchen = await Kitchen.findById(sub.kitchen).select("latitude longitude serviceRadiusKm").lean();
  if (!kitchenCovers(kitchen, address.latitude, address.longitude)) throw new AppError(409, "Your kitchen does not deliver to this address. Contact support to move kitchens.");
  sub.address = addressSnapshot(address);
  sub.addressId = address._id;
  log(sub, "address_changed", null, "customer");
  await sub.save();
  // Future meals not yet locked go to the new address.
  const { MealSelection } = await import("./subscription.model.js");
  await MealSelection.updateMany({ subscription: sub._id, status: { $in: ["open", "selected"] } }, { $set: { address: sub.address } });
  return toSubscription(sub);
}

export async function switchBillingMethod(userId, billingMethod, by = "customer") {
  const sub = typeof userId === "object" ? userId : await requireOwn(userId);
  if (!sub.planSnapshot.billingMethods?.includes(billingMethod)) throw new AppError(422, "This plan does not offer that billing method");
  if (sub.billingMethod === billingMethod) return toSubscription(sub);
  if (billingMethod === "autopay") {
    const user = await User.findById(sub.user).lean();
    const mandate = await createGatewaySubscription({ planAmountPaise: sub.renewalPricePaise, intervalDays: sub.planSnapshot.cycleDays, notes: { subscriptionId: String(sub._id), planName: sub.planSnapshot.name }, customer: { phone: user?.phoneNumber } });
    sub.gatewaySubscriptionId = mandate.gatewaySubscriptionId;
    sub.mandateStatus = mandate.status;
    sub.billingMethod = "autopay";
    log(sub, "billing_switched", "autopay", by);
    await sub.save();
    return { ...toSubscription(sub), mandateUrl: mandate.shortUrl };
  }
  if (sub.gatewaySubscriptionId) await cancelGatewaySubscription(sub.gatewaySubscriptionId).catch(() => {});
  sub.billingMethod = "link";
  sub.gatewaySubscriptionId = null;
  log(sub, "billing_switched", "link", by);
  await sub.save();
  return toSubscription(sub);
}

export async function myInvoices(userId) {
  const subs = await Subscription.find({ user: userId }).select("_id").lean();
  const payments = await Payment.find({ refType: "subscription", refId: { $in: subs.map((sub) => sub._id) } }).select("_id").lean();
  const invoices = await Invoice.find({ refType: "subscription", refId: { $in: payments.map((payment) => payment._id) } }).sort({ issuedAt: -1 }).lean();
  const { toInvoice } = await import("../billing/billing.service.js");
  return invoices.map(toInvoice);
}

// ------------------------------------------------------------------ admin

export async function listSubscriptions({ status, kitchenId, planCode, q, page = 1, limit = 25 }) {
  const filter = {};
  if (status) filter.status = status === "live" ? { $in: LIVE } : status;
  if (kitchenId) filter.kitchen = objectId(kitchenId, "kitchen ID");
  if (planCode) filter["planSnapshot.planCode"] = String(planCode).toUpperCase();
  if (q) {
    const users = await User.find({ $or: [{ phoneNumber: { $regex: String(q).replace(/\D/g, "") || "^$" } }, { name: { $regex: String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] }).select("_id").limit(200).lean();
    filter.user = { $in: users.map((user) => user._id) };
  }
  const [items, total] = await Promise.all([
    Subscription.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("user", "name phoneNumber").lean(),
    Subscription.countDocuments(filter),
  ]);
  return { items: items.map((sub) => ({ ...toSubscription(sub), customer: sub.user ? { userId: String(sub.user._id), name: sub.user.name, phone: sub.user.phoneNumber } : null })), page, limit, total };
}

export async function getSubscriptionAdmin(subscriptionId) {
  const sub = await Subscription.findById(objectId(subscriptionId, "subscription ID")).populate("user", "name phoneNumber email").lean();
  if (!sub) throw new AppError(404, "Subscription not found");
  const payments = await Payment.find({ refType: "subscription", refId: sub._id }).sort({ createdAt: -1 }).lean();
  return {
    ...toSubscription(sub),
    customer: sub.user ? { userId: String(sub.user._id), name: sub.user.name, phone: sub.user.phoneNumber, email: sub.user.email } : null,
    history: sub.history || [],
    payments: payments.map((payment) => ({ paymentId: String(payment._id), cycle: payment.cycle, amountPaise: payment.amountPaise, method: payment.method, status: payment.status, gateway: payment.gateway, createdAt: payment.createdAt, capturedAt: payment.capturedAt })),
  };
}

export async function adminAction(subscriptionId, { action, months, reasonId, comment, days, billingMethod }, actorName) {
  const sub = await Subscription.findById(objectId(subscriptionId, "subscription ID"));
  if (!sub) throw new AppError(404, "Subscription not found");
  const by = `admin:${actorName || ""}`;
  if (action === "pause") return pause(sub, { months }, by);
  if (action === "resume") return resume(sub, by);
  if (action === "cancel") return cancel(sub, { reasonId, comment: comment || "Cancelled by MealJi" }, by);
  if (action === "switch_billing") return switchBillingMethod(sub, billingMethod, by);
  if (action === "resend_link") {
    await sendPaymentLink(sub, { reason: "resent_by_admin" });
    return toSubscription(sub);
  }
  if (action === "extend") {
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new AppError(422, "Extend by 1 to 60 days");
    sub.validTill = addIstDays(sub.validTill || istDateKey(), days);
    log(sub, "extended", `${days} day(s): ${comment || ""}`, by);
    await sub.save();
    await syncUser(sub);
    return toSubscription(sub);
  }
  if (action === "reactivate" && ["past_due"].includes(sub.status)) {
    sub.status = "active";
    sub.pastDueSince = null;
    log(sub, "reactivated", comment, by);
    await sub.save();
    await syncUser(sub);
    return toSubscription(sub);
  }
  throw new AppError(422, "Unknown action");
}

// ------------------------------------------------------------------ metrics

export async function subscriptionDayMetrics() {
  const live = await Subscription.find({ status: { $in: ["active", "pause_scheduled", "cancel_scheduled", "past_due"] } }).select("planSnapshot renewalPricePaise").lean();
  const mrr = live.reduce((sum, sub) => sum + Math.round(((sub.renewalPricePaise ?? sub.planSnapshot.pricePaise) * 30) / (sub.planSnapshot.cycleDays || 30)), 0);
  return { activeSubscribers: live.length, mrrPaise: mrr };
}

export async function subscriptionDashboard({ from, to }) {
  const toKey = to || istDateKey();
  const fromKey = from || addIstDays(toKey, -29);
  const range = { $gte: istDateTime(fromKey), $lt: istDateTime(addIstDays(toKey, 1)) };
  const { OutboxEvent } = await import("../../events/outbox.model.js");
  const counts = await OutboxEvent.aggregate([
    { $match: { occurredAt: range, name: { $in: ["subscription.activated", "subscription.renewed", "subscription.renewal_failed", "subscription.pause_scheduled", "subscription.cancel_scheduled", "subscription.cancelled", "subscription.cancel_undone", "meal.shifted"] } } },
    { $group: { _id: "$name", total: { $sum: 1 } } },
  ]);
  const byName = Object.fromEntries(counts.map((row) => [row._id, row.total]));
  const reasons = await Subscription.aggregate([
    { $match: { "cancellation.requestedAt": range } },
    { $group: { _id: { $ifNull: ["$cancellation.reason", "Not given"] }, total: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  const plans = await Subscription.aggregate([
    { $match: { status: { $in: LIVE } } },
    { $group: { _id: "$planSnapshot.name", total: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  const { MealSelection } = await import("./subscription.model.js");
  const meals = await MealSelection.aggregate([
    { $match: { date: { $gte: fromKey, $lte: toKey } } },
    { $group: { _id: { slot: "$slot", status: "$status", source: "$source" }, total: { $sum: 1 } } },
  ]);
  const { MetricsDaily } = await import("../analytics/analytics.model.js");
  const series = await MetricsDaily.find({ kitchen: null, date: { $gte: fromKey, $lte: toKey } }).sort({ date: 1 }).select("date metrics.activeSubscribers metrics.mrrPaise").lean();
  const now = await subscriptionDayMetrics();
  const cancelled = byName["subscription.cancel_scheduled"] || 0;
  return {
    from: fromKey,
    to: toKey,
    activeSubscribers: now.activeSubscribers,
    mrrPaise: now.mrrPaise,
    newSubscriptions: byName["subscription.activated"] || 0,
    renewals: byName["subscription.renewed"] || 0,
    renewalFailures: byName["subscription.renewal_failed"] || 0,
    pauses: byName["subscription.pause_scheduled"] || 0,
    cancellations: cancelled,
    cancelUndone: byName["subscription.cancel_undone"] || 0,
    churnRate: now.activeSubscribers + cancelled ? Math.round((cancelled / (now.activeSubscribers + cancelled)) * 1000) / 1000 : null,
    cancelReasons: reasons.map((row) => ({ reason: row._id, total: row.total })),
    planMix: plans.map((row) => ({ plan: row._id, total: row.total })),
    meals: meals.map((row) => ({ slot: row._id.slot, status: row._id.status, source: row._id.source, total: row.total })),
    series: series.map((row) => ({ date: row.date, activeSubscribers: row.metrics?.activeSubscribers ?? null, mrrPaise: row.metrics?.mrrPaise ?? null })),
  };
}

export { LIVE, emit, log, policyFor, syncUser };
