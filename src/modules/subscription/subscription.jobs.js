import { istDateKey } from "../../common/time.js";
import { logger } from "../../config/logger.js";
import { gatewayName } from "../../infrastructure/payments/gateway.js";
import { Payment } from "../payment/payment.model.js";
import { Subscription } from "./subscription.model.js";
import { daysBetween } from "./subscription.rules.js";
import { emit, log, policyFor, sendPaymentLink, syncUser } from "./subscription.service.js";

/**
 * Daily at 00:05 IST: pauses start, pauses end, scheduled cancellations finish,
 * past-due subscriptions run out of grace, and abandoned checkouts expire.
 */
export async function dailySubscriptionRun() {
  const today = istDateKey();
  let changed = 0;

  for (const sub of await Subscription.find({ status: "pause_scheduled", "pause.startsOn": { $lte: today } })) {
    sub.status = "paused";
    log(sub, "paused");
    await sub.save();
    await syncUser(sub);
    await emit("subscription.paused", sub, { resumesOn: sub.pause?.resumesOn });
    changed += 1;
  }
  for (const sub of await Subscription.find({ status: "paused", "pause.resumesOn": { $lte: today } })) {
    // Billing for the new cycle starts on the resume date.
    sub.status = "active";
    sub.nextBillingDate = today;
    sub.pause = undefined;
    log(sub, "auto_resumed");
    await sub.save();
    await syncUser(sub);
    await emit("subscription.resumed", sub);
    changed += 1;
  }
  for (const sub of await Subscription.find({ status: "cancel_scheduled", validTill: { $lt: today } })) {
    sub.status = "cancelled";
    log(sub, "cancelled");
    await sub.save();
    await syncUser(sub);
    await emit("subscription.cancelled", sub);
    changed += 1;
  }
  for (const sub of await Subscription.find({ status: "past_due" })) {
    const policy = await policyFor(sub);
    if (sub.pastDueSince && daysBetween(sub.pastDueSince, today) > policy.graceDays) {
      sub.status = "expired";
      log(sub, "expired", "grace period over");
      await sub.save();
      await syncUser(sub);
      await emit("subscription.expired", sub);
      changed += 1;
    }
  }
  const stale = await Subscription.deleteMany({ status: "pending_payment", expiresPaymentAt: { $lt: new Date() } });
  return changed + (stale.deletedCount || 0);
}

/**
 * Every 15 minutes: reminders (T-N days), pre-debit notices for autopay,
 * payment links for pay-each-cycle subscribers, and the move to past_due when
 * a cycle starts unpaid. In the test gateway autopay charges are simulated.
 */
export async function billingRun() {
  const today = istDateKey();
  let actions = 0;
  const subs = await Subscription.find({ status: { $in: ["active", "pause_scheduled"] }, nextBillingDate: { $ne: null } });
  for (const sub of subs) {
    try {
      const policy = await policyFor(sub);
      const daysLeft = daysBetween(today, sub.nextBillingDate);
      if (sub.status === "pause_scheduled" && sub.pause?.startsOn && sub.pause.startsOn <= sub.nextBillingDate) continue; // no billing while paused
      const amountPaise = sub.renewalPricePaise ?? sub.planSnapshot.pricePaise;

      // Renewal reminders.
      for (const days of policy.reminderDaysBefore || []) {
        const key = `${sub.cycle}:${days}`;
        if (daysLeft === days && !sub.remindersSent.includes(key)) {
          sub.remindersSent.push(key);
          await sub.save();
          await emit("subscription.renewal_reminder", sub, { daysLeft: days, nextBillingDate: sub.nextBillingDate, amountPaise });
          if (sub.billingMethod === "link") await sendPaymentLink(sub, { reason: `reminder_${days}d` });
          actions += 1;
        }
      }
      // Pre-debit notice for autopay (RBI e-mandate rule).
      const noticeDays = Math.ceil((policy.preDebitNoticeHours || 24) / 24);
      const noticeKey = `${sub.cycle}:predebit`;
      if (sub.billingMethod === "autopay" && daysLeft <= noticeDays && daysLeft >= 0 && !sub.remindersSent.includes(noticeKey)) {
        sub.remindersSent.push(noticeKey);
        await sub.save();
        await emit("subscription.pre_debit", sub, { nextBillingDate: sub.nextBillingDate, amountPaise });
        actions += 1;
      }

      if (daysLeft > 0) continue;
      const paid = await Payment.exists({ refType: "subscription", refId: sub._id, cycle: sub.cycle + 1, status: "captured" });
      if (paid) continue;

      if (sub.billingMethod === "autopay" && gatewayName() === "test") {
        // Simulated autopay charge (development).
        const payment = await Payment.create({ user: sub.user, refType: "subscription", refId: sub._id, kitchen: sub.kitchen, amountPaise, method: "autopay", gateway: "test", gatewaySubscriptionId: sub.gatewaySubscriptionId, cycle: sub.cycle + 1 });
        const { onPaymentCaptured } = await import("../payment/payment.service.js");
        await onPaymentCaptured(payment, { gatewayPaymentId: `pay_test_auto_${Date.now()}`, method: "autopay" });
        actions += 1;
        continue;
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
        actions += 1;
      }
    } catch (err) {
      logger.warn({ err: err.message, subscriptionId: String(sub._id) }, "Billing run failed for a subscription");
    }
  }
  // Past-due: keep the link fresh once a day.
  for (const sub of await Subscription.find({ status: "past_due" })) {
    const key = `${sub.cycle}:pastdue:${today}`;
    if (sub.remindersSent.includes(key)) continue;
    sub.remindersSent.push(key);
    await sub.save();
    await sendPaymentLink(sub, { reason: "past_due" }).catch(() => {});
  }
  return actions;
}

