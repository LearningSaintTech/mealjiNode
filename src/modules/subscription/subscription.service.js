import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { addIstDays, istDateKey, istDateTime } from "../../common/time.js";
import { acquireLock, releaseLock } from "../../infrastructure/redisStore.js";
import { logger } from "../../config/logger.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { cancelGatewaySubscription, cancelPaymentLink, createGatewayOrder, createGatewaySubscription, createPaymentLink, gatewayName, pauseGatewaySubscription, resumeGatewaySubscription, updateGatewaySubscriptionAmount } from "../../infrastructure/payments/gateway.js";
import { publish } from "../../realtime/hub.js";
import { Address, addressSnapshot, toAddress } from "../address/address.model.js";
import { issueInvoice } from "../billing/billing.service.js";
import { Invoice } from "../billing/billing.model.js";
import { Payment } from "../payment/payment.model.js";
import { kitchenCovers, kitchenForPoint } from "../serviceability/serviceability.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { User } from "../user/user.model.js";
import { cycleUnit, planSnapshot, plansForKitchen, toPlan } from "./plan.service.js";
import { Subscription, SubscriptionPlan } from "./subscription.model.js";
import { daysBetween, pauseDates } from "./subscription.rules.js";

const LIVE = ["active", "pause_scheduled", "paused", "cancel_scheduled", "past_due"];

// ------------------------------------------------------------------ views

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_LABELS = { pending_payment: "Payment pending", active: "Active", pause_scheduled: "Active", paused: "Paused", cancel_scheduled: "Active", past_due: "Payment due", cancelled: "Cancelled", expired: "Expired" };
const rupeeText = (paise) => `₹${Math.round((paise || 0) / 100).toLocaleString("en-IN")}`;

function keyParts(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}
/** “Nov 24, 2026” */
export function monthDayYear(dateKey) {
  if (!dateKey) return null;
  const d = keyParts(dateKey);
  return `${MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
}
/** “28 Oct 2026” */
export function dayMonthYear(dateKey) {
  if (!dateKey) return null;
  const d = keyParts(dateKey);
  return `${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}
/** “Today, Oct 24”, “Tomorrow, Oct 25”, else “Sat, Oct 26”. */
export function startLabel(dateKey) {
  if (!dateKey) return null;
  const d = keyParts(dateKey);
  const today = istDateKey();
  const prefix = dateKey === today ? "Today" : dateKey === addIstDays(today, 1) ? "Tomorrow" : WEEKDAYS[d.weekday];
  return `${prefix}, ${MONTHS[d.month - 1]} ${d.day}`;
}

export function toSubscription(sub) {
  const plan = sub.planSnapshot || {};
  const today = istDateKey();
  return {
    subscriptionId: String(sub._id),
    status: sub.status,
    plan: { planId: String(sub.plan), planCode: plan.planCode, name: plan.name, description: plan.description || plan.subtitle || "", pricePaise: plan.pricePaise, cycleDays: plan.cycleDays, cycleLabel: plan.cycleLabel, slots: plan.slots, mealsPerDay: plan.mealsPerDay, maxItemsPerMeal: plan.maxItemsPerMeal, benefits: plan.benefits || [] },
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
    pause: sub.pause?.startsOn ? { ...(sub.pause.toObject?.() || sub.pause), startsOnText: dayMonthYear(sub.pause.startsOn), resumesOnText: dayMonthYear(sub.pause.resumesOn), label: sub.status === "paused" ? `Paused · resumes ${dayMonthYear(sub.pause.resumesOn)}` : `Pauses on ${dayMonthYear(sub.pause.startsOn)} · resumes ${dayMonthYear(sub.pause.resumesOn)}` } : null,
    scheduledChange: sub.scheduledChange?.plan ? { planId: String(sub.scheduledChange.plan), planName: sub.scheduledChange.planName, pricePaise: sub.scheduledChange.pricePaise ?? null, effectiveOn: sub.scheduledChange.effectiveOn, effectiveOnText: dayMonthYear(sub.scheduledChange.effectiveOn), label: `Changes to ${sub.scheduledChange.planName} on ${dayMonthYear(sub.scheduledChange.effectiveOn)}` } : null,
    cancellation: sub.cancellation?.effectiveOn ? sub.cancellation : null,
    shiftsThisCycle: sub.shiftsThisCycle || 0,
    shiftsLeft: plan.maxShiftsPerCycle > 0 ? Math.max(0, plan.maxShiftsPerCycle - (sub.shiftsThisCycle || 0)) : null, // null = no limit
    paymentLink: sub.paymentLink?.url ? { url: sub.paymentLink.url, amountPaise: sub.paymentLink.amountPaise, cycle: sub.paymentLink.cycle } : null,
    pastDueSince: sub.pastDueSince,
    createdAt: sub.createdAt,
    // Screen wording: Plan confirmed and My Subscription.
    statusLabel: sub.status === "cancel_scheduled" && sub.validTill ? `Ends on ${dayMonthYear(sub.validTill)}` : STATUS_LABELS[sub.status] || sub.status,
    planLabel: `${plan.name} (${rupeeText(plan.pricePaise)})`,
    priceLabel: `${rupeeText(sub.renewalPricePaise ?? plan.pricePaise)} / ${cycleUnit(plan).toLowerCase()}`,
    startDateLabel: startLabel(sub.startDate),
    nextBillingDateLabel: monthDayYear(sub.nextBillingDate),
    validTillLabel: dayMonthYear(sub.validTill),
    validTillText: sub.validTill ? `Valid till ${dayMonthYear(sub.validTill)}` : null,
    // Plan Details, Update Address.
    nextBillingDateText: dayMonthYear(sub.nextBillingDate),
    nextChargePaise: nextCyclePricePaise(sub),
    autoRenewLabel: sub.autoRenew === false ? "Auto-renewal off" : "Auto-renewal on",
    planChangeNote: "Any plan change starts from your next billing cycle.",
    addressNote: "Changes apply to your next delivery",
    mandateUrl: sub.billingMethod === "autopay" && sub.mandateUrl && !["active", "authenticated", "paused"].includes(sub.mandateStatus) ? sub.mandateUrl : null,
  };
}

/** What the next cycle costs: a planned plan change applies from it. */
export function nextCyclePricePaise(sub) {
  if (sub.scheduledChange?.plan && Number.isInteger(sub.scheduledChange.pricePaise) && (!sub.nextBillingDate || !sub.scheduledChange.effectiveOn || sub.scheduledChange.effectiveOn <= sub.nextBillingDate)) return sub.scheduledChange.pricePaise;
  return sub.renewalPricePaise ?? sub.planSnapshot?.pricePaise;
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
    pricePaise: nextCyclePricePaise(sub),
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
/** Checks shared by the payment screen and Checkout: plan, address, kitchen, start day. */
async function quote(userId, { planCode, billingMethod = null, addressId, startDate = null }) {
  if (await currentSubscription(userId)) throw new AppError(409, "You already have a Meal Ji Plus subscription");
  const plan = await SubscriptionPlan.findOne({ code: String(planCode).toUpperCase(), status: "active" }).lean();
  if (!plan) throw new AppError(404, "Plan not found");
  if (billingMethod && !plan.billingMethods.includes(billingMethod)) throw new AppError(422, `This plan is billed by ${plan.billingMethods.join(" or ")}`);
  const address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: userId, deletedAt: null }).lean();
  if (!address) throw new AppError(404, "Address not found");
  const match = await kitchenForPoint(address.latitude, address.longitude, { preferOpen: false });
  if (!match) throw new AppError(409, "We don't deliver MealJi Plus to this address yet");
  const available = await plansForKitchen(match.kitchen._id);
  if (!available.some((item) => item.planCode === plan.code)) throw new AppError(409, "This plan is not available at your address");
  const today = istDateKey();
  const start = startDate && startDate > today ? startDate : addIstDays(today, 1);
  if (daysBetween(today, start) > 30) throw new AppError(422, "Start within the next 30 days");
  const deliveryPaise = plan.deliveryIncluded ? 0 : plan.deliveryFeePaise || 0;
  return { plan, address, match, start, deliveryPaise, amountPaise: plan.pricePaise + deliveryPaise };
}

// Ways to pay on the plan payment screen (all inside the gateway checkout).
// Pay on Delivery is not offered for a subscription.
const PLAN_PAYMENT_OPTIONS = [
  { key: "upi", label: "UPI", subtitle: "Google Pay, PhonePe, Paytm and other UPI apps" },
  { key: "card", label: "Credit / Debit card", subtitle: "Visa, Mastercard, RuPay" },
  { key: "wallet", label: "Wallets", subtitle: "Paytm, Amazon Pay, Mobikwik" },
  { key: "netbanking", label: "Net Banking", subtitle: "50+ banks" },
];

/** Plan payment screen: address, bill, total, start and next billing date, ways to pay. */
export async function checkoutSummary(userId, input) {
  const { plan, address, start, deliveryPaise, amountPaise } = await quote(userId, input);
  const { SavedPaymentMethod, toMethod } = await import("../payment/paymentMethod.service.js");
  const saved = await SavedPaymentMethod.find({ user: userId }).sort({ isDefault: -1, updatedAt: -1 }).limit(10).lean();
  const nextBilling = addIstDays(start, plan.cycleDays);
  return {
    plan: toPlan(plan),
    address: toAddress(address),
    billLines: [
      { key: "plan", label: `${plan.name} (${plan.cycleDays} days)`, amountPaise: plan.pricePaise, text: rupeeText(plan.pricePaise) },
      { key: "delivery", label: "Delivery", amountPaise: deliveryPaise, text: deliveryPaise ? rupeeText(deliveryPaise) : "Free" },
      { key: "tax", label: "Taxes", amountPaise: 0, text: "Included" },
    ],
    totalPaise: amountPaise,
    totalLabel: rupeeText(amountPaise),
    startDate: start,
    startDateLabel: startLabel(start),
    nextBillingDate: nextBilling,
    nextBillingDateLabel: monthDayYear(nextBilling),
    billingMethods: plan.billingMethods,
    paymentOptions: PLAN_PAYMENT_OPTIONS,
    payOnDelivery: false,
    savedMethods: saved.map(toMethod).filter((method) => !method.expired),
  };
}

export async function checkout(userId, input) {
  // One checkout at a time per customer: a double tap must not start two plans.
  const lockKey = `subscription:checkout:${userId}`;
  const token = await acquireLock(lockKey, 30);
  if (!token) throw new AppError(409, "Your plan purchase is already in progress", [{ field: "subscription", message: "CHECKOUT_IN_PROGRESS" }]);
  try {
    return await checkoutLocked(userId, input);
  } finally {
    await releaseLock(lockKey, token);
  }
}

async function checkoutLocked(userId, input) {
  const { billingMethod } = input;
  const { plan, address, match, start, amountPaise } = await quote(userId, input);
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
  if ((payment.cycle || 0) > 1) return applyCapture(payment);
  // First payments of one customer are applied one at a time, so two paid
  // checkouts can never both become live plans.
  const lockKey = `subscription:activate:${payment.user}`;
  let token = null;
  for (let attempt = 0; attempt < 20 && !token; attempt += 1) {
    token = await acquireLock(lockKey, 30);
    if (!token) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!token) throw new AppError(503, "Subscription activation is busy. It will be retried.");
  try {
    return await applyCapture(payment);
  } finally {
    await releaseLock(lockKey, token);
  }
}

/** Gives back a first payment that cannot start a plan (checkout gone, or another plan already live). */
async function refundExtraPayment(payment, sub, reason) {
  const { requestRefund } = await import("../payment/payment.service.js");
  await requestRefund({ subscriptionId: sub?._id || null, paymentId: payment._id, amountPaise: payment.amountPaise, reason, actor: { role: "system" }, permissions: ["refunds.approve"] });
  logger.warn({ paymentId: String(payment._id), subscriptionId: sub ? String(sub._id) : null }, "Extra subscription payment refunded");
}

async function applyCapture(payment) {
  const found = await Subscription.findById(payment.refId).select("_id").lean();
  if (!found) {
    // The checkout was replaced or cleaned up before this payment arrived.
    if ((payment.cycle || 1) === 1) await refundExtraPayment(payment, null, "Payment for a plan checkout that no longer exists");
    return;
  }
  // Same lock as customer actions and the billing jobs: nothing changes the plan meanwhile.
  return withSubLock(found, (sub) => applyCaptureLocked(sub, payment));
}

/** Whether a cycle that is already paid was paid by this payment (a retry) or by another one. */
async function paidByAnother(sub, payment, cycle) {
  if (sub.lastPaymentId) return String(sub.lastPaymentId) !== String(payment._id);
  // Plans paid before lastPaymentId existed: another captured payment for the same cycle.
  return Boolean(await Payment.exists({ refType: "subscription", refId: sub._id, cycle, _id: { $ne: payment._id }, status: { $in: ["captured", "partially_refunded"] }, orphanCharge: { $ne: true } }));
}

async function applyCaptureLocked(sub, payment) {
  const cycle = payment.cycle || sub.cycle + 1;
  if (cycle <= sub.cycle) {
    // Already paid: a second payment for the same cycle (two links, link + autopay) is given back.
    if (await paidByAnother(sub, payment, cycle)) await refundExtraPayment(payment, sub, "This month was already paid");
    return;
  }
  // A renewal charged while the plan is paused (e.g. autopay that could not be stopped) is given back.
  if (cycle > 1 && (sub.status === "paused" || (sub.status === "pause_scheduled" && sub.pause?.startsOn && sub.pause.startsOn <= (sub.nextBillingDate || istDateKey())))) {
    log(sub, "paused_charge_refunded", `cycle ${cycle}`);
    await sub.save();
    await refundExtraPayment(payment, sub, "Charged while the plan was paused");
    return;
  }
  // A renewal for a plan that ended or is set to end (a late link payment) does not bring it back.
  if (cycle > 1 && ["cancelled", "expired", "cancel_scheduled"].includes(sub.status)) {
    log(sub, "late_payment_refunded", `cycle ${cycle}`);
    await sub.save();
    await refundExtraPayment(payment, sub, sub.status === "cancel_scheduled" ? "The plan is set to end" : "The plan had already ended");
    return;
  }
  if (cycle === 1 && sub.status === "pending_payment") {
    const other = await Subscription.exists({ user: sub.user, _id: { $ne: sub._id }, status: { $in: LIVE } });
    if (other) {
      sub.status = "cancelled";
      log(sub, "duplicate_payment_refunded");
      await sub.save();
      await refundExtraPayment(payment, sub, "Duplicate payment: a Meal Ji Plus plan is already active");
      return;
    }
  }
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
        // The customer approves the mandate here (Plan confirmed shows it until approved).
        sub.mandateUrl = mandate.shortUrl || null;
      } catch (err) {
        logger.warn({ err: err.message }, "Autopay mandate could not be created; falling back to payment links");
        sub.billingMethod = "link";
      }
    }
  } else {
    // Renewal: apply a scheduled plan change when this payment covers its price.
    if (sub.scheduledChange?.plan) {
      const next = await SubscriptionPlan.findById(sub.scheduledChange.plan).lean();
      if (next && payment.amountPaise >= next.pricePaise) {
        sub.plan = next._id;
        sub.planSnapshot = planSnapshot(next);
        sub.renewalPricePaise = next.pricePaise;
        sub.scheduledChange = undefined;
        log(sub, "plan_changed", next.name);
        await emit("subscription.plan_changed", sub);
      } else if (next) {
        // Paid the old price (a link sent before the change): the change waits one more cycle.
        log(sub, "plan_change_deferred", `${next.name}: paid ${payment.amountPaise}, needs ${next.pricePaise}`);
      } else {
        sub.scheduledChange = undefined;
      }
    }
    // The new period starts after the last served day: shifted meals on extra
    // days are never overlapped by the paid days of the next cycle.
    let start = sub.nextBillingDate && sub.nextBillingDate > istDateKey() ? sub.nextBillingDate : (sub.status === "paused" || sub.status === "past_due" ? istDateKey() : sub.nextBillingDate);
    if (sub.validTill && start <= sub.validTill) start = addIstDays(sub.validTill, 1);
    sub.currentPeriodStart = start;
    sub.currentPeriodEnd = addIstDays(start, sub.planSnapshot.cycleDays - 1);
    sub.validTill = sub.currentPeriodEnd;
    sub.nextBillingDate = addIstDays(sub.currentPeriodEnd, 1);
    sub.cycle = cycle;
    sub.status = "active";
    sub.pastDueSince = null;
    sub.renewalAttempts = 0;
    sub.shiftsThisCycle = 0;
    sub.autoShiftsThisCycle = 0;
    sub.paymentLink = undefined;
    sub.remindersSent = [];
    log(sub, "renewed", `cycle ${cycle}`);
  }
  sub.lastPaymentId = payment._id;
  await sub.save();
  // Other unpaid links for this cycle can no longer be paid.
  await cancelOpenLinks(sub, { cycle, except: payment._id });
  await syncUser(sub);
  await invoiceCycle(sub, payment);
  await emit(cycle === 1 ? "subscription.activated" : "subscription.renewed", sub, { cycle, amountPaise: payment.amountPaise });
}

/** The last day meals are served: the paid period, or later when meals were shifted past it. */
export function lastServedDay(sub) {
  return sub.validTill && sub.currentPeriodEnd && sub.validTill > sub.currentPeriodEnd ? sub.validTill : sub.currentPeriodEnd;
}

/**
 * Stops the autopay mandate (cancelled at the gateway) and remembers its id, so
 * a charge that still arrives from it is recognised and refunded.
 */
export async function dropMandate(sub, note) {
  const had = Boolean(sub.gatewaySubscriptionId);
  if (had) {
    await cancelGatewaySubscription(sub.gatewaySubscriptionId).catch((err) => logger.warn({ err: err.message, subscriptionId: String(sub._id) }, "Mandate cancel failed (a late charge will be refunded)"));
    sub.pastMandateIds = [...new Set([...(sub.pastMandateIds || []), sub.gatewaySubscriptionId])];
  }
  sub.gatewaySubscriptionId = null;
  if (had) sub.mandateStatus = "cancelled";
  sub.mandateUrl = null;
  if (sub.billingMethod === "autopay") {
    sub.billingMethod = "link";
    if (note) log(sub, "billing_switched", note);
  }
}

/** Closes unpaid payment links of a plan (all, or one cycle's except the payment that paid it). */
export async function cancelOpenLinks(sub, { cycle = null, except = null } = {}) {
  const open = await Payment.find({ refType: "subscription", refId: sub._id, status: "created", gatewayLinkId: { $ne: null }, ...(cycle ? { cycle } : {}), ...(except ? { _id: { $ne: except } } : {}) }).lean();
  for (const link of open) {
    await cancelPaymentLink(link.gatewayLinkId).catch((err) => logger.warn({ err: err.message, paymentId: String(link._id) }, "Payment link cancel failed (a payment on it will be refunded)"));
    await Payment.updateOne({ _id: link._id, status: "created" }, { $set: { status: "cancelled" } });
  }
  if (sub.paymentLink?.linkId && open.some((link) => link.gatewayLinkId === sub.paymentLink.linkId)) sub.paymentLink = undefined;
  return open.length;
}

/** After a plan change: a link already sent for the next cycle at another price is replaced. */
async function replaceStaleLink(sub) {
  const nextCycle = sub.cycle + 1;
  if (sub.paymentLink?.linkId && sub.paymentLink.cycle === nextCycle && sub.paymentLink.amountPaise !== nextCyclePricePaise(sub)) {
    await cancelOpenLinks(sub, { cycle: nextCycle });
    sub.paymentLink = undefined;
    log(sub, "payment_link_replaced", "plan changed");
    // A reminder in the window gets a fresh link at the right price.
    if (sub.nextBillingDate && daysBetween(istDateKey(), sub.nextBillingDate) <= 3) await sendPaymentLink(sub, { reason: "plan_changed" }).catch(() => {});
  }
}

export async function onSubscriptionPaymentFailed(payment, reason) {
  const found = await Subscription.findById(payment.refId).select("_id status").lean();
  if (!found || found.status === "pending_payment") return;
  await withSubLock(found, async (sub) => {
    sub.renewalAttempts += 1;
    log(sub, "renewal_failed", reason);
    await sub.save();
    await emit("subscription.renewal_failed", sub, { reason });
    // Autopay failed: fall back to a payment link for this cycle.
    if (sub.billingMethod === "autopay") await sendPaymentLink(sub, { reason: "autopay_failed" }).catch(() => {});
  }).catch((err) => logger.warn({ err: err.message, subscriptionId: String(found._id) }, "Failed renewal not recorded"));
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
  let sub = entity ? await Subscription.findOne({ gatewaySubscriptionId: entity.id }) : null;
  if (!sub && entity) {
    // A mandate the plan no longer uses (cancelled at cycle end, switched, paused failed).
    const old = await Subscription.findOne({ $or: [{ pastMandateIds: entity.id }, ...(entity.notes?.subscriptionId && /^[a-f0-9]{24}$/.test(String(entity.notes.subscriptionId)) ? [{ _id: entity.notes.subscriptionId }] : [])] });
    if (old && body.event === "subscription.charged") return refundOrphanCharge(old, body.payload?.payment?.entity, entity.id);
    if (!old && body.event === "subscription.charged") logger.error({ mandate: entity.id, payment: body.payload?.payment?.entity?.id }, "Autopay charge for an unknown mandate: refund it in the Razorpay dashboard");
    return "ignored";
  }
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

/** A charge from a mandate the plan no longer uses: recorded and refunded in full, never applied. */
async function refundOrphanCharge(sub, paymentEntity, mandateId) {
  if (!paymentEntity?.id) return "ignored";
  if (await Payment.exists({ gatewayPaymentId: paymentEntity.id })) return "ignored";
  const payment = await Payment.create({ user: sub.user, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise: paymentEntity.amount, method: paymentEntity.method || "autopay", gateway: "razorpay", gatewayPaymentId: paymentEntity.id, gatewaySubscriptionId: mandateId, status: "captured", capturedAt: new Date(), applyState: "done", appliedAt: new Date(), orphanCharge: true });
  await refundExtraPayment(payment, sub, "Charge from an autopay mandate that was already stopped");
  return "processed";
}

/** Creates (or re-sends) the payment link for the next cycle. */
export async function sendPaymentLink(sub, { reason = "cycle" } = {}) {
  const cycle = sub.cycle + 1;
  const amountPaise = nextCyclePricePaise(sub);
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
  if (!sub) throw new AppError(404, "You don't have an active Meal Ji Plus subscription");
  return sub;
}

/**
 * Runs one change to a plan at a time (pause, resume, cancel, plan change,
 * address, billing): a double tap or two screens at once cannot mix them.
 * `target` is the customer's id or a subscription (admin). The work gets a
 * freshly read subscription.
 */
async function withSubLock(target, work) {
  const found = typeof target === "object" && target?._id ? target : await requireOwn(target);
  const lockKey = `subscription:action:${found._id}`;
  const token = await acquireLock(lockKey, 90);
  if (!token) throw new AppError(409, "Another change to your plan is in progress. Try again in a moment.");
  try {
    const sub = await Subscription.findById(found._id);
    if (!sub) throw new AppError(404, "Subscription not found");
    return await work(sub);
  } finally {
    await releaseLock(lockKey, token);
  }
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
  return { subscriptionId: view.subscriptionId, status: view.status, statusLabel: view.statusLabel, planName: view.plan.name, planCode: view.plan.planCode, priceLabel: view.priceLabel, validTill: view.validTill, validTillText: view.validTillText, daysLeft: view.daysLeft, slots: view.plan.slots };
}

function pauseChoices(sub, policy) {
  const options = [];
  for (let months = policy.pauseMinMonths; months <= policy.pauseMaxMonths; months += 1) {
    const dates = pauseDates({ months, startsMode: policy.pauseStarts, currentPeriodEnd: lastServedDay(sub), today: istDateKey() });
    const title = `Pause for ${months} month${months > 1 ? "s" : ""}`;
    options.push({ months, ...dates, title, subtitle: `Resume automatically on ${dayMonthYear(dates.resumesOn)}`, buttonLabel: title, startsOnText: dayMonthYear(dates.startsOn) });
  }
  return options;
}

/** Pause Subscription screen. */
export async function pauseOptions(userId) {
  const sub = await requireOwn(userId);
  const policy = await policyFor(sub);
  const startsLater = policy.pauseStarts === "cycle_end";
  return {
    title: "Take a break, not a goodbye",
    subtitle: "Pause deliveries and billing temporarily. Your preferences stay saved.",
    options: pauseChoices(sub, policy),
    startsAt: policy.pauseStarts,
    whilePaused: "No meals will be delivered and no payment will be taken. You can resume anytime from My Subscription.",
    note: startsLater ? `The pause starts after your paid days end on ${dayMonthYear(sub.currentPeriodEnd)}. You are not charged while paused.` : "The pause starts tomorrow. Your remaining paid days continue after the pause.",
    cancelLabel: "Not now",
  };
}

/** Pause choices for one subscription (admin acting on behalf). */
export async function pauseOptionsFor(subscriptionId) {
  const sub = await Subscription.findById(objectId(subscriptionId, "subscription ID"));
  if (!sub) throw new AppError(404, "Subscription not found");
  const policy = await policyFor(sub);
  return { options: pauseChoices(sub, policy), startsAt: policy.pauseStarts };
}

/** Autopay must not charge while a plan is paused. */
async function setMandatePaused(sub, paused) {
  if (sub.billingMethod !== "autopay" || !sub.gatewaySubscriptionId) return;
  try {
    const result = paused ? await pauseGatewaySubscription(sub.gatewaySubscriptionId) : await resumeGatewaySubscription(sub.gatewaySubscriptionId);
    sub.mandateStatus = result?.status || (paused ? "paused" : "active");
  } catch (err) {
    // Could not pause the mandate: stop autopay instead, so no charge is taken while paused.
    if (!paused) throw err;
    logger.warn({ err: err.message, subscriptionId: String(sub._id) }, "Mandate pause failed; switching to payment links");
    await dropMandate(sub, "link (autopay could not be paused)");
  }
}

export function pause(userId, { months }, by = "customer") {
  return withSubLock(userId, async (sub) => {
    const policy = await policyFor(sub);
    if (!Number.isInteger(months) || months < policy.pauseMinMonths || months > policy.pauseMaxMonths) throw new AppError(422, `Pause for ${policy.pauseMinMonths} to ${policy.pauseMaxMonths} month(s)`);
    if (sub.status !== "active") throw new AppError(409, sub.status === "cancel_scheduled" ? "Undo the cancellation first to pause your plan" : ["pause_scheduled", "paused"].includes(sub.status) ? "Your plan is already paused" : "Only an active subscription can be paused");
    const dates = pauseDates({ months, startsMode: policy.pauseStarts, currentPeriodEnd: lastServedDay(sub), today: istDateKey() });
    // A pause from tomorrow keeps the paid days that are left: they run after the pause.
    const daysLeft = policy.pauseStarts === "next_day" && sub.validTill && sub.validTill >= dates.startsOn ? daysBetween(dates.startsOn, sub.validTill) + 1 : 0;
    sub.pause = { ...dates, months, daysLeft, requestedAt: new Date() };
    sub.status = "pause_scheduled";
    await setMandatePaused(sub, true);
    log(sub, "pause_scheduled", `${dates.startsOn} to ${dates.resumesOn}`, by);
    await sub.save();
    await syncUser(sub);
    await emit("subscription.pause_scheduled", sub, { resumesOn: dates.resumesOn });
    return toSubscription(sub);
  });
}

/**
 * Ends a pause (customer, admin or the daily job). A pause that had not
 * started yet just goes away. A running pause starts the plan again today:
 * paid days carried past the pause are served first, otherwise a new cycle is
 * billed today.
 */
export async function applyResume(sub, { by = "customer", event = "resumed" } = {}) {
  const wasPaused = sub.status === "paused";
  const carried = sub.pause?.daysLeft || 0;
  sub.pause = undefined;
  sub.status = "active";
  if (wasPaused) {
    const today = istDateKey();
    if (carried > 0) {
      sub.currentPeriodStart = today;
      sub.currentPeriodEnd = addIstDays(today, carried - 1);
      sub.validTill = sub.currentPeriodEnd;
      sub.nextBillingDate = addIstDays(today, carried);
    } else {
      sub.nextBillingDate = today;
    }
  }
  await setMandatePaused(sub, false);
  log(sub, event, null, by);
  await sub.save();
  await syncUser(sub);
  await emit("subscription.resumed", sub);
  return toSubscription(sub);
}

export function resume(userId, by = "customer") {
  return withSubLock(userId, async (sub) => {
    if (!["pause_scheduled", "paused"].includes(sub.status)) throw new AppError(409, "This subscription is not paused");
    return applyResume(sub, { by });
  });
}

export async function cancelReasons() {
  const policy = (await resolveSetting("subscription_policy")).values;
  return policy.cancelReasons.map((label, index) => ({ reasonId: `r${index + 1}`, label }));
}

/** Cancel Subscription + Confirm Cancellation screens. */
export async function cancelInfo(userId) {
  const sub = await requireOwn(userId);
  const policy = await policyFor(sub);
  const view = toSubscription(sub);
  const shortName = shortPlanName(view.plan.name);
  return {
    title: "What made you decide to cancel?",
    subtitle: `Your feedback helps us improve. You can still go back without changing your ${shortName} Plan.`,
    reasons: await cancelReasons(),
    pauseOffer: `Pause for up to ${policy.pauseMaxMonths} months.`,
    canPause: sub.status === "active",
    confirmTitle: `Cancel your ${shortName} Plan?`,
    confirmSubtitle: "This is the final step. Nothing changes until you tap “Cancel subscription” below.",
    planName: view.plan.name,
    priceLabel: view.priceLabel,
    statusLabel: view.statusLabel,
    points: [
      `You can use your remaining meals until ${view.validTillLabel}.`,
      `Auto-renewal stops and no payment will be taken on ${dayMonthYear(sub.nextBillingDate || addIstDays(sub.validTill, 1))}.`,
      "Your billing history stays available. You can subscribe again anytime.",
    ],
    keepLabel: "Keep my subscription",
    cancelLabel: "Cancel subscription",
  };
}

export function cancel(userId, { reasonId, comment }, by = "customer") {
  return withSubLock(userId, async (sub) => {
    if (!["active", "pause_scheduled", "paused", "past_due"].includes(sub.status)) throw new AppError(409, sub.status === "cancel_scheduled" ? "Your plan is already set to end" : "This subscription cannot be cancelled now");
    const reasons = await cancelReasons();
    const reason = reasons.find((item) => item.reasonId === reasonId);
    if (!reason && by === "customer") throw new AppError(422, "Choose a reason");
    // A paused plan that is cancelled has no autopay left to resume.
    sub.cancellation = { reasonId: reasonId || null, reason: reason?.label || null, comment: comment ? String(comment).slice(0, 500) : null, effectiveOn: sub.validTill || istDateKey(), requestedAt: new Date() };
    sub.status = "cancel_scheduled";
    sub.autoRenew = false;
    sub.pause = undefined;
    sub.scheduledChange = undefined;
    // The mandate is cancelled: nothing more is charged; undo continues with payment links.
    await dropMandate(sub, "plan cancelled");
    // An unpaid link for the next cycle must not renew a plan that is ending.
    await cancelOpenLinks(sub);
    log(sub, "cancel_scheduled", reason?.label, by);
    await sub.save();
    await syncUser(sub);
    await emit("subscription.cancel_scheduled", sub, { reasonId, reason: reason?.label || null, validTill: sub.validTill });
    return toSubscription(sub);
  });
}

export function undoCancel(userId) {
  return withSubLock(userId, async (sub) => {
    if (sub.status !== "cancel_scheduled") throw new AppError(409, "Nothing to undo");
    if (!(await policyFor(sub)).allowCancelUndo) throw new AppError(403, "Cancellations cannot be undone");
    sub.status = "active";
    sub.autoRenew = true;
    sub.cancellation = undefined;
    // Any old mandate was cancelled; renewals continue by payment link until a new mandate is set up.
    if (sub.gatewaySubscriptionId) await dropMandate(sub, "plan kept after a cancel");
    log(sub, "cancel_undone", null, "customer");
    await sub.save();
    await syncUser(sub);
    await emit("subscription.cancel_undone", sub);
    return toSubscription(sub);
  });
}

const shortPlanName = (name) => String(name || "").replace(/\s+(Monthly|Weekly|Quarterly|Yearly)$/i, "");
const perCycleText = (plan) => `${rupeeText(plan.pricePaise)} / ${cycleUnit(plan).toLowerCase()}`;
const featuresText = (plan) => (plan.benefits || []).slice(0, 3).join(" • ");

async function changeContext(sub) {
  const policy = await policyFor(sub);
  const effectiveOn = policy.planChangeTiming === "immediately" ? istDateKey() : sub.nextBillingDate;
  return { policy, effectiveOn, immediate: policy.planChangeTiming === "immediately" };
}

/** Change Plan screen: the plans sold at the member's kitchen, current one marked. */
export async function changePlanOptions(userId) {
  const sub = await requireOwn(userId);
  const { effectiveOn, immediate } = await changeContext(sub);
  const plans = await plansForKitchen(sub.kitchen);
  const current = sub.planSnapshot.planCode;
  const scheduled = sub.scheduledChange?.plan ? String(sub.scheduledChange.plan) : null;
  return {
    title: "Choose a plan that fits",
    plans: plans.map((plan) => ({ ...plan, isCurrent: plan.planCode === current, isScheduled: plan.planId === scheduled, priceText: perCycleText(plan), featuresLabel: featuresText(plan), diffPaise: plan.pricePaise - (sub.renewalPricePaise ?? sub.planSnapshot.pricePaise) })),
    effectiveOn,
    effectiveOnText: dayMonthYear(effectiveOn),
    note: immediate ? "Your new plan starts today. The new price applies from your next bill." : `Your new plan begins on ${dayMonthYear(effectiveOn)}. No charge today.`,
    keepLabel: `Keep ${shortPlanName(sub.planSnapshot.name)} Plan`,
    canChange: ["active", "pause_scheduled", "paused"].includes(sub.status),
  };
}

function assertCanChange(sub) {
  if (sub.status === "cancel_scheduled") throw new AppError(409, "Undo the cancellation first to change your plan");
  if (sub.status === "past_due") throw new AppError(409, "Pay the due bill first to change your plan");
}

export async function changePlanPreview(userId, planCode) {
  const sub = typeof userId === "object" ? userId : await requireOwn(userId);
  assertCanChange(sub);
  const next = await SubscriptionPlan.findOne({ code: String(planCode).toUpperCase(), status: "active" }).lean();
  if (!next) throw new AppError(404, "Plan not found");
  if (String(next._id) === String(sub.plan)) throw new AppError(409, "You are already on this plan");
  const available = await plansForKitchen(sub.kitchen);
  if (!available.some((plan) => plan.planCode === next.code)) throw new AppError(409, "This plan is not available at your address");
  const { effectiveOn, immediate } = await changeContext(sub);
  const diff = next.pricePaise - (sub.renewalPricePaise ?? sub.planSnapshot.pricePaise);
  return {
    current: toSubscription(sub).plan,
    next: toPlan(next),
    effectiveOn,
    effectiveOnText: dayMonthYear(effectiveOn),
    chargeTodayPaise: 0,
    nextChargePaise: next.pricePaise,
    diffPaise: diff,
    // Footer: “Standard Monthly • ₹4,499 / month”, “+₹1,000”, “Continue with Standard”.
    summaryLabel: `${next.name} • ${perCycleText(next)}`,
    diffLabel: `${diff > 0 ? "+" : diff < 0 ? "-" : ""}${rupeeText(Math.abs(diff))}`,
    continueLabel: `Continue with ${shortPlanName(next.name)}`,
    note: immediate ? "Your plan changes today; the new price applies from your next bill." : `Your new plan begins on ${dayMonthYear(effectiveOn)}. No charge today.`,
  };
}

/** Autopay charges the plan price: follow a plan change (or its undoing) from the next cycle. */
async function syncMandateAmount(sub, amountPaise, planName) {
  if (sub.billingMethod !== "autopay" || !sub.gatewaySubscriptionId) return;
  try {
    await updateGatewaySubscriptionAmount(sub.gatewaySubscriptionId, { planAmountPaise: amountPaise, intervalDays: sub.planSnapshot.cycleDays, planName });
  } catch (err) {
    // The mandate keeps the old amount: bill by payment link instead so the right price is charged.
    logger.warn({ err: err.message, subscriptionId: String(sub._id) }, "Mandate amount update failed; switching to payment links");
    await dropMandate(sub, "link (autopay amount could not be changed)");
  }
}

export function changePlan(userId, planCode) {
  return withSubLock(userId, async (sub) => {
    assertCanChange(sub);
    const code = String(planCode).toUpperCase();
    // Keep … Plan: picking the current plan again drops a planned change.
    if (code === sub.planSnapshot.planCode) {
      if (!sub.scheduledChange?.plan) throw new AppError(409, "You are already on this plan");
      sub.scheduledChange = undefined;
      await syncMandateAmount(sub, sub.renewalPricePaise ?? sub.planSnapshot.pricePaise, sub.planSnapshot.name);
      await replaceStaleLink(sub);
      log(sub, "plan_change_cancelled", null, "customer");
      await sub.save();
      return toSubscription(sub);
    }
    const preview = await changePlanPreview(sub, code);
    const next = await SubscriptionPlan.findById(preview.next.planId).lean();
    if (preview.effectiveOn === istDateKey()) {
      sub.plan = next._id;
      sub.planSnapshot = planSnapshot(next);
      sub.renewalPricePaise = next.pricePaise;
      sub.scheduledChange = undefined;
      log(sub, "plan_changed", next.name, "customer");
    } else {
      sub.scheduledChange = { plan: next._id, planName: next.name, pricePaise: next.pricePaise, effectiveOn: preview.effectiveOn };
      log(sub, "plan_change_scheduled", next.name, "customer");
    }
    await syncMandateAmount(sub, next.pricePaise, next.name);
    await replaceStaleLink(sub);
    await sub.save();
    await emit("subscription.plan_change_scheduled", sub, { nextPlanName: next.name, effectiveOn: preview.effectiveOn });
    return toSubscription(sub);
  });
}

export function updateAddress(userId, addressId) {
  return withSubLock(userId, async (sub) => {
    const address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: sub.user, deletedAt: null }).lean();
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
  });
}

export function switchBillingMethod(userId, billingMethod, by = "customer") {
  return withSubLock(userId, async (sub) => {
    if (!sub.planSnapshot.billingMethods?.includes(billingMethod)) throw new AppError(422, "This plan does not offer that billing method");
    if (sub.billingMethod === billingMethod) return toSubscription(sub);
    if (billingMethod === "autopay" && sub.status === "cancel_scheduled") throw new AppError(409, "Undo the cancellation first to turn on autopay");
    if (billingMethod === "autopay" && sub.status === "past_due") throw new AppError(409, "Pay the due bill first, then turn on autopay");
    if (billingMethod === "autopay") {
      const user = await User.findById(sub.user).lean();
      const mandate = await createGatewaySubscription({ planAmountPaise: nextCyclePricePaise(sub), intervalDays: sub.planSnapshot.cycleDays, notes: { subscriptionId: String(sub._id), planName: sub.scheduledChange?.planName || sub.planSnapshot.name }, customer: { phone: user?.phoneNumber } });
      sub.gatewaySubscriptionId = mandate.gatewaySubscriptionId;
      sub.mandateStatus = mandate.status;
      sub.mandateUrl = mandate.shortUrl || null;
      sub.billingMethod = "autopay";
      // A paused plan: the new mandate waits too.
      if (["pause_scheduled", "paused"].includes(sub.status)) await setMandatePaused(sub, true);
      log(sub, "billing_switched", "autopay", by);
      await sub.save();
      return { ...toSubscription(sub), mandateUrl: mandate.shortUrl };
    }
    await dropMandate(sub, null);
    sub.billingMethod = "link";
    log(sub, "billing_switched", "link", by);
    await sub.save();
    return toSubscription(sub);
  });
}

const BILLING_LABELS = { autopay: "Autopay (UPI / card mandate)", link: "Payment link each month" };
const INVOICE_STATUS = { issued: "PAID", paid: "PAID", cancelled: "CANCELLED", credited: "REFUNDED" };

/** Billing History screen: totals, next payment, how the plan is billed, invoices. */
export async function myInvoices(userId) {
  const subs = await Subscription.find({ user: userId }).select("_id status nextBillingDate billingMethod renewalPricePaise planSnapshot scheduledChange").sort({ createdAt: -1 }).lean();
  const payments = await Payment.find({ refType: "subscription", refId: { $in: subs.map((sub) => sub._id) } }).select("_id status amountPaise refundedPaise method").lean();
  const invoices = await Invoice.find({ refType: "subscription", refId: { $in: payments.map((payment) => payment._id) } }).sort({ issuedAt: -1 }).lean();
  const { toInvoice } = await import("../billing/billing.service.js");
  const live = subs.find((sub) => LIVE.includes(sub.status)) || null;
  const totalPaid = payments.filter((payment) => ["captured", "partially_refunded"].includes(payment.status)).reduce((sum, payment) => sum + payment.amountPaise - (payment.refundedPaise || 0), 0);
  const billed = live && ["active", "pause_scheduled", "past_due"].includes(live.status) && live.nextBillingDate;
  return {
    totalPaidPaise: totalPaid,
    totalPaidLabel: rupeeText(totalPaid),
    nextPaymentDate: billed ? live.nextBillingDate : null,
    nextPaymentLabel: billed ? dayMonthYear(live.nextBillingDate).replace(/ \d{4}$/, "") : null,
    nextPaymentPaise: billed ? nextCyclePricePaise(live) : null,
    billingMethod: live?.billingMethod || null,
    paymentMethodLabel: live ? BILLING_LABELS[live.billingMethod] || live.billingMethod : null,
    hint: "Tap the download icon to save a GST invoice.",
    items: invoices.map((invoice) => {
      const view = toInvoice(invoice);
      const [year, month] = view.date.split("-").map(Number);
      return {
        ...view,
        monthLabel: `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1]} ${year}`,
        dateLabel: `${dayMonthYear(view.date)} • ${view.invoiceNumber}`,
        amountLabel: rupeeText(view.totalPaise),
        statusLabel: INVOICE_STATUS[view.status] || String(view.status || "").toUpperCase(),
        pdfPath: `/subscriptions/me/invoices/${view.invoiceId}/pdf`,
      };
    }),
  };
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
    return withSubLock(sub, async (fresh) => {
      await sendPaymentLink(fresh, { reason: "resent_by_admin" });
      return toSubscription(fresh);
    });
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

export { LIVE, emit, log, policyFor, syncUser, withSubLock };
