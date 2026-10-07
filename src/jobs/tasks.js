import { logger } from "../config/logger.js";
import { OutboxEvent } from "../events/outbox.model.js";
import { activateDueSettings } from "../modules/settings/settings.service.js";

// Recurring jobs. `every` is in milliseconds; `pattern` is a cron expression
// evaluated in India time. Modules are imported lazily so a job only loads
// what it runs.

const lazy = (path, fn) => async () => (await import(path))[fn]();

/** Anonymises accounts closed more than 30 days ago (orders are kept for tax). */
async function purgeDeletedAccounts() {
  const { User } = await import("../modules/user/user.model.js");
  const { Address } = await import("../modules/address/address.model.js");
  const { DeviceToken, Notification } = await import("../modules/notification/notification.model.js");
  const { Order } = await import("../modules/order/order.model.js");
  const { Cart } = await import("../modules/cart/cart.model.js");
  const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
  const users = await User.find({ deletedAt: { $lte: cutoff }, name: { $ne: "Deleted user" } }).limit(200).lean();
  for (const user of users) {
    await Promise.all([
      Address.deleteMany({ user: user._id }),
      DeviceToken.deleteMany({ user: user._id }),
      Notification.deleteMany({ user: user._id }),
      Cart.deleteOne({ user: user._id }),
      Order.updateMany({ user: user._id }, { $set: { "customer.name": "Deleted user", "customer.phone": null, "address.recipientName": null, "address.phone": null } }),
    ]);
    await User.updateOne({ _id: user._id }, {
      $set: { name: "Deleted user", phoneNumber: `deleted-${user._id}`, email: null, dob: null, gender: null, avatarUrl: null, currentLocation: null, isActive: false },
      $unset: { referralCode: 1 },
    });
  }
  return users.length;
}

export const SCHEDULED_TASKS = [
  { name: "settings-activation", every: 60_000, description: "Puts scheduled setting changes into effect", run: activateDueSettings },
  { name: "order-watchdog", every: 60_000, description: "Expires unpaid orders, raises accept-SLA alerts and auto-cancels unaccepted orders", run: lazy("../modules/order/order.service.js", "orderWatchdog") },
  { name: "delivery-watchdog", every: 60_000, description: "Books deliveries after the accept offset and retries failed bookings", run: lazy("../modules/delivery/delivery.service.js", "deliveryWatchdog") },
  { name: "analytics-rollup", pattern: "5 * * * *", description: "Hourly metrics rollups for today and yesterday", run: lazy("../modules/analytics/analytics.service.js", "rollupRecent") },
  { name: "payment-reconciliation", pattern: "0 3 * * *", description: "Compares captured payments with the gateway", run: lazy("../modules/payment/payment.service.js", "reconcilePayments") },
  { name: "report-schedules", every: 5 * 60_000, description: "Emails scheduled report exports", run: lazy("../modules/report/report.service.js", "runDueSchedules") },
  { name: "account-purge", pattern: "30 2 * * *", description: "Anonymises accounts closed more than 30 days ago", run: purgeDeletedAccounts },
  { name: "subscription-daily", pattern: "5 0 * * *", description: "Renewals, reminders, pauses, resumes, cancellations and plan changes", run: lazy("../modules/subscription/subscription.jobs.js", "dailySubscriptionRun") },
  { name: "subscription-billing", every: 15 * 60_000, description: "Charges due renewals and sends payment links", run: lazy("../modules/subscription/subscription.jobs.js", "billingRun") },
  { name: "meal-cutoffs", every: 60_000, description: "Selection reminders, cutoff locks (auto-shift) and meal drops", run: lazy("../modules/subscription/mealplan.jobs.js", "mealCutoffRun") },
  { name: "loyalty-daily", pattern: "0 9 * * *", description: "Birthday points and points expiry", run: lazy("../modules/rewards/rewards.service.js", "dailyLoyaltyRun") },
  { name: "support-sla", every: 5 * 60_000, description: "Flags tickets past their SLA", run: lazy("../modules/support/support.service.js", "slaWatchdog") },
  { name: "campaign-dispatcher", every: 60_000, description: "Sends scheduled and recurring campaigns", run: lazy("../modules/engagement/campaign.service.js", "dispatchDueCampaigns") },
  { name: "journey-runner", every: 60_000, description: "Advances journey enrollments whose wait is over", run: lazy("../modules/engagement/journey.service.js", "runDueEnrollments") },
  { name: "warehouse-export", pattern: "15 2 * * *", description: "Writes yesterday's events and orders for the data warehouse", run: lazy("../modules/analytics/analytics.service.js", "exportWarehouseDay") },
  { name: "segment-traits", pattern: "15 1 * * *", description: "Nightly recompute of user traits and segment sizes", run: lazy("../modules/engagement/traits.service.js", "recomputeAllTraits") },
  {
    name: "housekeeping",
    pattern: "30 3 * * *",
    description: "Daily cleanup of old failed events",
    async run() {
      const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const { deletedCount } = await OutboxEvent.deleteMany({ status: "failed", occurredAt: { $lt: cutoff } });
      return deletedCount;
    },
  },
];

export async function runTask(name) {
  const task = SCHEDULED_TASKS.find((item) => item.name === name);
  if (!task) throw new Error(`Unknown scheduled task ${name}`);
  const startedAt = Date.now();
  try {
    const result = await task.run();
    logger.debug({ task: name, result, ms: Date.now() - startedAt }, "Scheduled task finished");
    return result;
  } catch (err) {
    // A module from a later phase that is not present yet is skipped quietly.
    if (err?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw err;
  }
}
