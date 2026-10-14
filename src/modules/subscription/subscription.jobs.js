import { addIstDays, istDateKey } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { gatewayName } from "../../infrastructure/payments/gateway.js";
import { acquireLock, releaseLock } from "../../infrastructure/redisStore.js";
import { Payment } from "../payment/payment.model.js";
import { Subscription } from "./subscription.model.js";
import { daysBetween } from "./subscription.rules.js";
import { applyResume, cancelOpenLinks, dropMandate, emit, log, nextCyclePricePaise, policyFor, sendPaymentLink, syncUser, withSubLock } from "./subscription.service.js";

/** One run of a job at a time, across processes (a slow run is not overlapped by the next). */
async function exclusive(name, ttlSec, work) {
  const token = await acquireLock(`job:${name}`, ttlSec).catch(() => null);
  if (!token) return 0;
  try {
    return await work();
  } finally {
    await releaseLock(`job:${name}`, token);
  }
}

/**
 * Works on each matching plan under the same lock customer actions use, with a
 * freshly read plan; one plan failing (gateway down, lock busy) never stops the
 * others — it is picked up on the next run.
 */
async function eachPlan(filter, work, label) {
  const ids = await Subscription.find(filter).select("_id").lean();
  let changed = 0;
  for (const { _id } of ids) {
    try {
      if (await withSubLock({ _id }, work)) changed += 1;
    } catch (err) {
      logger.warn({ err: err.message, subscriptionId: String(_id), step: label }, "Subscription job step failed; retried next run");
    }
  }
  return changed;
}

/**
 * Daily at 00:05 IST: pauses start, pauses end, scheduled cancellations finish,
 * past-due subscriptions run out of grace, and abandoned checkouts expire.
 */
export function dailySubscriptionRun() {
  return exclusive("subscription-daily", 3600, async () => {
    const today = istDateKey();
    let changed = 0;
    changed += await eachPlan({ status: "pause_scheduled", "pause.startsOn": { $lte: today } }, async (sub) => {
      if (sub.status !== "pause_scheduled" || !(sub.pause?.startsOn <= today)) return false;
      sub.status = "paused";
      log(sub, "paused");
      await sub.save();
      await syncUser(sub);
      await emit("subscription.paused", sub, { resumesOn: sub.pause?.resumesOn });
      return true;
    }, "pause");
    changed += await eachPlan({ status: "paused", "pause.resumesOn": { $lte: today } }, async (sub) => {
      if (sub.status !== "paused" || !(sub.pause?.resumesOn <= today)) return false;
      // Billing for the new cycle starts on the resume date (after any carried paid days).
      await applyResume(sub, { by: "system", event: "auto_resumed" });
      return true;
    }, "resume");
    changed += await eachPlan({ status: "cancel_scheduled", validTill: { $lt: today } }, async (sub) => {
      if (sub.status !== "cancel_scheduled" || !(sub.validTill < today)) return false;
      sub.status = "cancelled";
      await dropMandate(sub, null);
      await cancelOpenLinks(sub);
      log(sub, "cancelled");
      await sub.save();
      await syncUser(sub);
      await emit("subscription.cancelled", sub);
      return true;
    }, "cancel");
    changed += await eachPlan({ status: "past_due" }, async (sub) => {
      if (sub.status !== "past_due") return false;
      const policy = await policyFor(sub);
      if (!sub.pastDueSince || daysBetween(sub.pastDueSince, today) <= policy.graceDays) return false;
      sub.status = "expired";
      await dropMandate(sub, null);
      await cancelOpenLinks(sub);
      log(sub, "expired", "grace period over");
      await sub.save();
      await syncUser(sub);
      await emit("subscription.expired", sub);
      return true;
    }, "expire");
    const stale = await Subscription.deleteMany({ status: "pending_payment", expiresPaymentAt: { $lt: new Date() } });
    return changed + (stale.deletedCount || 0);
  });
}

/** One plan's billing step: reminders, pre-debit notice, the due-day charge or link, past_due. */
async function billOne(sub, today) {
  if (!["active", "pause_scheduled"].includes(sub.status) || !sub.nextBillingDate) return false;
  const policy = await policyFor(sub);
  const daysLeft = daysBetween(today, sub.nextBillingDate);
  if (sub.status === "pause_scheduled" && sub.pause?.startsOn && sub.pause.startsOn <= sub.nextBillingDate) return false; // no billing while paused
  const amountPaise = nextCyclePricePaise(sub);
  let acted = false;

  // Renewal reminders.
  for (const days of policy.reminderDaysBefore || []) {
    const key = `${sub.cycle}:${days}`;
    if (daysLeft === days && !sub.remindersSent.includes(key)) {
      sub.remindersSent.push(key);
      await sub.save();
      await emit("subscription.renewal_reminder", sub, { daysLeft: days, nextBillingDate: sub.nextBillingDate, amountPaise });
      if (sub.billingMethod === "link") await sendPaymentLink(sub, { reason: `reminder_${days}d` });
      acted = true;
    }
  }
  // Pre-debit notice for autopay (RBI e-mandate rule).
  const noticeDays = Math.ceil((policy.preDebitNoticeHours || 24) / 24);
  const noticeKey = `${sub.cycle}:predebit`;
  if (sub.billingMethod === "autopay" && daysLeft <= noticeDays && daysLeft >= 0 && !sub.remindersSent.includes(noticeKey)) {
    sub.remindersSent.push(noticeKey);
    await sub.save();
    await emit("subscription.pre_debit", sub, { nextBillingDate: sub.nextBillingDate, amountPaise });
    acted = true;
  }

  if (daysLeft > 0) return acted;
  const paid = await Payment.exists({ refType: "subscription", refId: sub._id, cycle: sub.cycle + 1, status: "captured" });
  if (paid) return acted;

  if (sub.billingMethod === "autopay" && gatewayName() === "test") {
    // Simulated autopay charge (development). Applied after the lock is released.
    return { simulate: { amountPaise } };
  }
  if (sub.billingMethod === "link" && !sub.paymentLink?.url) await sendPaymentLink(sub, { reason: "due" });
  // Autopay with Razorpay: give the charge a day to arrive, then fall back to a link.
  if (sub.billingMethod === "autopay" && daysLeft <= -1 && sub.paymentLink?.cycle !== sub.cycle + 1) {
    await sendPaymentLink(sub, { reason: "autopay_missing" });
  }
  if (daysLeft <= (sub.billingMethod === "autopay" ? -1 : 0) && sub.status !== "past_due") {
    sub.status = "past_due";
    sub.pastDueSince = sub.nextBillingDate;
    log(sub, "past_due");
    await sub.save();
    await syncUser(sub);
    await emit("subscription.renewal_failed", sub, { reason: "unpaid", graceDays: policy.graceDays });
    acted = true;
  }
  return acted;
}

/**
 * Every 15 minutes: reminders (T-N days), pre-debit notices for autopay,
 * payment links for pay-each-cycle subscribers, and the move to past_due when
 * a cycle starts unpaid. In the test gateway autopay charges are simulated.
 * Only plans billed within the reminder window are loaded.
 */
export function billingRun() {
  return exclusive("subscription-billing", 14 * 60, async () => {
    const today = istDateKey();
    let actions = 0;
    const horizon = addIstDays(today, 7);
    const ids = await Subscription.find({ status: { $in: ["active", "pause_scheduled"] }, nextBillingDate: { $ne: null, $lte: horizon } }).select("_id").lean();
    const { onPaymentCaptured } = await import("../payment/payment.service.js");
    for (const { _id } of ids) {
      try {
        const result = await withSubLock({ _id }, (sub) => billOne(sub, today));
        if (result?.simulate) {
          const sub = await Subscription.findById(_id).lean();
          const payment = await Payment.create({ user: sub.user, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise: result.simulate.amountPaise, method: "autopay", gateway: "test", gatewaySubscriptionId: sub.gatewaySubscriptionId, cycle: sub.cycle + 1 });
          await onPaymentCaptured(payment, { gatewayPaymentId: `pay_test_auto_${Date.now()}`, method: "autopay" });
        }
        if (result) actions += 1;
      } catch (err) {
        logger.warn({ err: err.message, subscriptionId: String(_id) }, "Billing run failed for a subscription; retried next run");
      }
    }
    // Past-due: keep the link fresh once a day.
    actions += await eachPlan({ status: "past_due" }, async (sub) => {
      const key = `${sub.cycle}:pastdue:${today}`;
      if (sub.status !== "past_due" || sub.remindersSent.includes(key)) return false;
      sub.remindersSent.push(key);
      await sub.save();
      await sendPaymentLink(sub, { reason: "past_due" }).catch(() => {});
      return true;
    }, "past_due_link");
    return actions;
  });
}
