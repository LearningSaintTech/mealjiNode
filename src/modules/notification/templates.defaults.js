// Default copy for every transactional message. An admin-saved template with
// the same key replaces it. Variables use {{path}} and are filled from `data`.

const order = (title, body, extra = {}, icon = "box") => ({
  category: "transactional",
  inboxCategory: "orders",
  channels: {
    push: { title, body, deepLink: "mealji://orders/{{order.orderId}}" },
    inapp: { title, body, icon, iconColor: "#EA580C", deepLink: "mealji://orders/{{order.orderId}}" },
    sms: { text: `MealJi: ${body}` },
    ...extra,
  },
  channelOrder: ["push", "inapp"],
});

export const DEFAULT_TEMPLATES = {
  "auth.welcome": {
    category: "transactional",
    inboxCategory: "account",
    channels: {
      push: { title: "Welcome to MealJi", body: "Home-style meals, cooked fresh near you." },
      inapp: { title: "Welcome to MealJi", body: "Your first meal is a few taps away.", icon: "sparkles", iconColor: "#EA580C", deepLink: "mealji://menu" },
      email: { subject: "Welcome to MealJi", html: "<p>Hi {{user.firstName}},</p><p>Welcome to MealJi. Your first meal is a few taps away.</p>", text: "Hi {{user.firstName}}, welcome to MealJi." },
    },
    channelOrder: ["push", "inapp"],
  },
  "order.placed": order("Order placed", "We've received order {{order.orderNumber}}. The kitchen will confirm shortly."),
  "order.accepted": order("Order confirmed", "{{order.kitchenName}} accepted order {{order.orderNumber}}."),
  "order.preparing": order("Cooking now", "Your food is being prepared."),
  "order.ready": order("Ready", "Order {{order.orderNumber}} is ready{{order.pickupSuffix}}."),
  "order.dispatched": order("On the way", "Order {{order.orderNumber}} is out for delivery.", {
    whatsapp: { providerTemplateName: "order_out_for_delivery", language: "en", waCategory: "utility", variables: ["order.orderNumber"], approvalStatus: "pending" },
  }, "moto"),
  "order.delivered": order("Delivered", "Enjoy your meal! Rate order {{order.orderNumber}} to earn points."),
  "order.cancelled": order("Order cancelled", "Order {{order.orderNumber}} was cancelled. {{order.refundNote}}"),
  "payment.failed": order("Payment failed", "Payment for order {{order.orderNumber}} did not go through. Tap to retry."),
  "refund.processed": {
    category: "transactional",
    inboxCategory: "orders",
    channels: {
      push: { title: "Refund processed", body: "₹{{refund.amount}} is on its way back to you." },
      inapp: { title: "Refund processed", body: "₹{{refund.amount}} refunded. It may take 5-7 working days to reach your account.", icon: "wallet", iconColor: "#16A34A" },
      sms: { text: "MealJi: Refund of Rs {{refund.amount}} processed. It may take 5-7 working days." },
    },
    channelOrder: ["push", "inapp"],
  },
  "order.receipt": {
    category: "transactional",
    inboxCategory: "orders",
    channels: { email: { subject: "Your MealJi receipt {{order.orderNumber}}", html: "<p>Thanks for ordering. Total ₹{{order.total}}.</p>", text: "Thanks for ordering. Total Rs {{order.total}}." } },
    channelOrder: ["email"],
  },
  "reward.earned": {
    category: "transactional",
    inboxCategory: "rewards",
    channels: {
      push: { title: "+{{reward.points}} points", body: "{{reward.title}}", deepLink: "mealji://rewards/history" },
      inapp: { title: "+{{reward.points}} points", body: "{{reward.title}}", icon: "star", iconColor: "#CA8A04", deepLink: "mealji://rewards/history" },
    },
    channelOrder: ["inapp"],
  },
  "reward.redeemed": {
    category: "transactional",
    inboxCategory: "rewards",
    channels: { inapp: { title: "Reward redeemed", body: "{{reward.title}}", icon: "gift", iconColor: "#CA8A04", deepLink: "mealji://rewards/history" } },
    channelOrder: ["inapp"],
  },
  "subscription.activated": sub("MealJi Plus is active", "Welcome to {{plan.name}}. Pick your meals before each cutoff."),
  "subscription.renewal_reminder": sub("Renews in {{subscription.daysLeft}} day(s)", "{{plan.name}} renews on {{subscription.nextBillingDate}} for ₹{{subscription.amount}}.", true),
  "subscription.pre_debit": sub("Upcoming auto-debit", "₹{{subscription.amount}} will be debited on {{subscription.nextBillingDate}} for {{plan.name}}.", true),
  "subscription.payment_link": sub("Pay to continue MealJi Plus", "Pay ₹{{subscription.amount}} for your next cycle: {{subscription.paymentUrl}}", true),
  "subscription.renewed": sub("Renewed", "{{plan.name}} renewed until {{subscription.validTill}}."),
  "subscription.renewal_failed": sub("Renewal failed", "We could not renew {{plan.name}}. Pay within {{subscription.graceDays}} day(s) to keep your meals.", true),
  "subscription.paused": sub("Subscription paused", "{{plan.name}} is paused until {{subscription.resumesOn}}."),
  "subscription.resumed": sub("Welcome back", "{{plan.name}} is active again."),
  "subscription.cancel_scheduled": sub("Cancellation scheduled", "{{plan.name}} stays active until {{subscription.validTill}}."),
  "subscription.cancelled": sub("Subscription ended", "{{plan.name}} has ended. We'd love to have you back."),
  "subscription.plan_change_scheduled": sub("Plan change scheduled", "You move to {{plan.nextName}} on {{subscription.nextBillingDate}}."),
  "meal.selection_reminder": meal("Pick your {{meal.slotName}}", "Choose today's {{meal.slotName}} before {{meal.cutoff}}."),
  "meal.auto_shifted": meal("We moved today's {{meal.slotName}}", "No meal was picked by the cutoff, so we moved it to {{meal.shiftedTo}}."),
  "meal.locked": meal("Your {{meal.slotName}} is locked in", "{{meal.items}}"),
  "meal.out_for_delivery": meal("Your {{meal.slotName}} is on the way", "It should reach you soon."),
  "support.ticket_update": {
    category: "transactional",
    inboxCategory: "account",
    channels: {
      push: { title: "Support update", body: "Ticket {{ticket.number}}: {{ticket.status}}", deepLink: "mealji://support/tickets/{{ticket.ticketId}}" },
      inapp: { title: "Support update", body: "Ticket {{ticket.number}}: {{ticket.message}}", icon: "help", iconColor: "#2563EB", deepLink: "mealji://support/tickets/{{ticket.ticketId}}" },
    },
    channelOrder: ["push", "inapp"],
  },
  "account.phone_changed": {
    category: "transactional",
    inboxCategory: "account",
    channels: { sms: { text: "MealJi: your account phone number was changed. If this wasn't you, contact support." } },
    channelOrder: ["sms"],
  },
  // Journeys (marketing: consent, quiet hours and caps apply).
  "journey.welcome": mk("offers", "Hungry? Your first meal is ready to order", "Fresh, home-style meals from a kitchen near you.", "mealji://menu"),
  "journey.first_order_offer": mk("offers", "A treat for your first order", "Use code {{couponCode}} for a little off your first MealJi meal.", "mealji://menu"),
  "journey.cart_waiting": mk("offers", "Your cart is waiting", "The food you picked is still in your cart. Ready to order?", "mealji://cart"),
  "journey.cart_offer": mk("offers", "Still thinking about it?", "Finish your order today and enjoy a small treat on us.", "mealji://cart"),
  "journey.rate_meal": mk("rewards", "How was your meal?", "Rate your order and earn points.", "mealji://orders/{{orderId}}/rate"),
  "journey.plus_upsell": mk("offers", "Save with MealJi Plus", "You order often. A plan gets you daily meals for less.", "mealji://plus"),
  "journey.pause_instead": mk("account", "Need a break instead?", "You can pause MealJi Plus for up to 3 months instead of cancelling.", "mealji://plus/pause"),
  "journey.win_back": mk("offers", "We miss you!", "Your favourite dishes are waiting. Order again today.", "mealji://menu"),
  "campaign.generic": mk("offers", "{{title}}", "{{body}}", "{{deepLink}}"),
  "ops.message": {
    category: "transactional",
    inboxCategory: "account",
    channels: { push: { title: "{{title}}", body: "{{body}}" }, inapp: { title: "{{title}}", body: "{{body}}", icon: "info", iconColor: "#2563EB" } },
    channelOrder: ["push", "inapp"],
  },
};

function sub(title, body, multi = false) {
  return {
    category: "transactional",
    inboxCategory: "account",
    channels: {
      push: { title, body, deepLink: "mealji://plus" },
      inapp: { title, body, icon: "crown", iconColor: "#7C3AED", deepLink: "mealji://plus" },
      ...(multi ? { whatsapp: { providerTemplateName: "subscription_update", language: "en", waCategory: "utility", variables: ["plan.name"], approvalStatus: "pending" }, email: { subject: title, html: `<p>${body}</p>`, text: body } } : {}),
    },
    channelOrder: multi ? ["push", "inapp", "whatsapp", "email"] : ["push", "inapp"],
  };
}

function meal(title, body) {
  return {
    category: "transactional",
    inboxCategory: "orders",
    channels: {
      push: { title, body, deepLink: "mealji://plus/meals/{{meal.date}}" },
      inapp: { title, body, icon: "utensils", iconColor: "#EA580C", deepLink: "mealji://plus/meals/{{meal.date}}" },
    },
    channelOrder: ["push", "inapp"],
  };
}

function mk(inboxCategory, title, body, deepLink) {
  return {
    category: "marketing",
    inboxCategory,
    channels: {
      push: { title, body, deepLink },
      inapp: { title, body, icon: "sparkles", iconColor: "#EA580C", deepLink },
      email: { subject: title, html: `<p>${body}</p>`, text: body },
    },
    channelOrder: ["push", "inapp"],
  };
}
