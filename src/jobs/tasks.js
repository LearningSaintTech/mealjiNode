import { logger } from "../config/logger.js";
import { OutboxEvent } from "../events/outbox.model.js";
import { activateDueSettings } from "../modules/settings/settings.service.js";

// Recurring jobs. `every` is in milliseconds; `pattern` is a cron expression
// evaluated in India time. Modules are imported lazily so a job only loads
// what it runs.

const lazy = (path, fn) => async () => (await import(path))[fn]();

/**
 * Anonymises accounts closed more than 30 days ago. Orders and invoices are
 * kept for tax with only the city, state and PIN code of the address; every
 * other personal detail goes: profile, addresses, devices, notifications,
 * cart, favorites, saved payment methods, support ticket text and files, app
 * analytics, plan addresses. Each account is claimed atomically first, so one
 * restored by a sign-in during the run is never touched. Runs until the
 * backlog is cleared (in batches), not a fixed number a day.
 */
async function purgeDeletedAccounts() {
  const { User } = await import("../modules/user/user.model.js");
  const { Address } = await import("../modules/address/address.model.js");
  const { DeviceToken, Notification } = await import("../modules/notification/notification.model.js");
  const { Order } = await import("../modules/order/order.model.js");
  const { Cart } = await import("../modules/cart/cart.model.js");
  const { Favorite } = await import("../modules/favorites/favorites.model.js");
  const { SavedPaymentMethod } = await import("../modules/payment/paymentMethod.service.js");
  const { SupportTicket, TicketMessage } = await import("../modules/support/support.model.js");
  const { AnalyticsEvent } = await import("../modules/analytics/analytics.model.js");
  const { Subscription } = await import("../modules/subscription/subscription.model.js");
  const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
  const addressGone = { recipientName: null, phone: null, houseFlat: null, street: null, locality: null, landmark: null, fullAddress: null, latitude: null, longitude: null };
  const prefixed = (prefix) => Object.fromEntries(Object.entries(addressGone).map(([key, value]) => [`${prefix}.${key}`, value]));
  let purged = 0;
  for (let batch = 0; batch < 100; batch += 1) {
    const due = await User.find({ purgedAt: null, deletedAt: { $lte: cutoff } }).select("_id").limit(200).lean();
    if (!due.length) break;
    for (const { _id } of due) {
      // Claim: still closed and not restored meanwhile.
      const user = await User.findOneAndUpdate({ _id, purgedAt: null, deletedAt: { $lte: cutoff } }, { $set: { purgedAt: new Date() } }, { new: true }).lean();
      if (!user) continue;
      try {
        const tickets = await SupportTicket.find({ user: _id }).select("_id").lean();
        await Promise.all([
          Address.deleteMany({ user: _id }),
          DeviceToken.deleteMany({ user: _id }),
          Notification.deleteMany({ user: _id }),
          Cart.deleteOne({ user: _id }),
          Favorite.deleteMany({ user: _id }),
          SavedPaymentMethod.deleteMany({ user: _id }),
          Order.updateMany({ user: _id }, { $set: { "customer.name": "Deleted user", "customer.phone": null, ...prefixed("address") } }),
          Subscription.updateMany({ user: _id }, { $set: prefixed("address") }),
          // A plan still running after 30 days ends with the account.
          Subscription.updateMany({ user: _id, status: { $in: ["active", "pause_scheduled", "paused", "cancel_scheduled", "past_due", "pending_payment"] } }, { $set: { status: "cancelled", autoRenew: false } }),
          SupportTicket.updateMany({ user: _id }, { $set: { subject: "[removed]", description: "[removed]", attachments: [] } }),
          TicketMessage.updateMany({ ticket: { $in: tickets.map((ticket) => ticket._id) }, "author.userId": _id }, { $set: { body: "[removed]", attachments: [], "author.name": "Deleted user" } }),
          AnalyticsEvent.deleteMany({ userId: _id }).catch((err) => logger.warn({ err: err.message }, "Analytics events of a closed account not removed")),
        ]);
        await User.updateOne({ _id }, {
          $set: { name: "Deleted user", phoneNumber: `deleted-${_id}`, email: null, dob: null, dobMonthDay: null, gender: null, avatarUrl: null, currentLocation: null, isActive: false, deletionReason: null },
          $unset: { referralCode: 1, preferences: 1, gatewayCustomer: 1 },
        });
        purged += 1;
      } catch (err) {
        // Not finished: release the claim so the next run completes it.
        await User.updateOne({ _id, purgedAt: user.purgedAt }, { $set: { purgedAt: null } });
        logger.error({ err: err.message, userId: String(_id) }, "Account purge failed; retried next run");
      }
    }
  }
  return purged;
}

export const SCHEDULED_TASKS = [
  { name: "settings-activation", every: 60_000, description: "Puts scheduled setting changes into effect", run: activateDueSettings },
  { name: "order-watchdog", every: 60_000, description: "Expires unpaid orders, raises accept-SLA alerts and auto-cancels unaccepted orders", run: lazy("../modules/order/order.service.js", "orderWatchdog") },
  { name: "delivery-watchdog", every: 60_000, description: "Books deliveries after the accept offset and retries failed bookings", run: lazy("../modules/delivery/delivery.service.js", "deliveryWatchdog") },
  { name: "analytics-rollup", pattern: "5 * * * *", description: "Hourly metrics rollups for today and yesterday", run: lazy("../modules/analytics/analytics.service.js", "rollupRecent") },
  { name: "payment-apply-retry", every: 5 * 60_000, description: "Finishes captured payments whose order or plan was not updated", run: lazy("../modules/payment/payment.service.js", "retryUnappliedPayments") },
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
  { name: "segment-memberships", every: 15 * 60_000, description: "Recomputes who is in each dynamic segment (home and offer targeting)", run: lazy("../modules/engagement/segment.service.js", "materializeSegments") },
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
