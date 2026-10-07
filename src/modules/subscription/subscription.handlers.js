// Subscription and meal events → notifications (push/inbox, WhatsApp utility and email where set).

const rupees = (paise) => (Number(paise || 0) / 100).toFixed(2).replace(/\.00$/, "");

const TEMPLATE = {
  "subscription.activated": "subscription.activated",
  "subscription.renewal_reminder": "subscription.renewal_reminder",
  "subscription.pre_debit": "subscription.pre_debit",
  "subscription.payment_link": "subscription.payment_link",
  "subscription.renewed": "subscription.renewed",
  "subscription.renewal_failed": "subscription.renewal_failed",
  "subscription.paused": "subscription.paused",
  "subscription.resumed": "subscription.resumed",
  "subscription.cancel_scheduled": "subscription.cancel_scheduled",
  "subscription.cancelled": "subscription.cancelled",
  "subscription.plan_change_scheduled": "subscription.plan_change_scheduled",
};

export function registerHandlers(subscribe) {
  subscribe("subscription.*", "notify.subscription", async (event) => {
    const templateKey = TEMPLATE[event.name];
    if (!templateKey) return;
    const { Subscription } = await import("./subscription.model.js");
    const { policyFor } = await import("./subscription.service.js");
    const sub = await Subscription.findById(event.payload.subscriptionId).lean();
    if (!sub) return;
    const policy = await policyFor(sub);
    const { notify } = await import("../notification/notification.service.js");
    await notify({
      userId: event.payload.userId,
      templateKey,
      data: {
        plan: { name: sub.planSnapshot?.name, nextName: event.payload.nextPlanName || sub.scheduledChange?.planName || null },
        subscription: {
          daysLeft: event.payload.daysLeft ?? null,
          nextBillingDate: sub.nextBillingDate,
          validTill: sub.validTill,
          resumesOn: sub.pause?.resumesOn || event.payload.resumesOn || null,
          amount: rupees(event.payload.amountPaise ?? sub.renewalPricePaise ?? sub.planSnapshot?.pricePaise),
          paymentUrl: event.payload.paymentUrl || sub.paymentLink?.url || "",
          graceDays: policy.graceDays,
        },
      },
      dedupeKey: `sub:${event.payload.subscriptionId}:${event.name}:${event.eventId}`,
    });
  });

  subscribe("meal.*", "notify.meal", async (event) => {
    const templateKey = { "meal.selection_due": "meal.selection_reminder", "meal.auto_shifted": "meal.auto_shifted", "meal.locked": "meal.locked", "meal.out_for_delivery": "meal.out_for_delivery" }[event.name];
    if (!templateKey) return;
    const cutoff = event.payload.cutoffAt ? new Date(event.payload.cutoffAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }) : null;
    let slotName = event.payload.slotName;
    if (!slotName && event.payload.slot) slotName = event.payload.slot;
    const { notify } = await import("../notification/notification.service.js");
    await notify({
      userId: event.payload.userId,
      templateKey,
      data: { meal: { slotName, cutoff, date: event.payload.date, shiftedTo: event.payload.shiftedTo, items: event.payload.items || "" } },
      dedupeKey: `meal:${event.payload.userId}:${event.payload.date}:${event.payload.slot}:${event.name}:${event.payload.minutesLeft ?? ""}`,
    });
  });
}
