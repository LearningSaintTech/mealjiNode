// Every admin- or kitchen-controllable business value is declared here. The
// console renders its forms from these definitions, the API validates against
// them, and `default` is only the seed used until someone saves a value.
//
// Field types: boolean, integer, money (integer paise), string, text, enum,
// multiEnum, time (HH:mm), version (semver x.y.z).
// `kitchenEditable` fields can be overridden by the kitchen admin for their own
// kitchen (within min/max). `public` fields are exposed to the app.
// Later phases add pricing, tax, billing entity, slot, loyalty and notification
// definitions to this same registry.

export const SCOPE_ORDER = ["global", "city", "kitchen"];

export const SETTING_DEFINITIONS = {
  app: {
    title: "App configuration",
    description: "Versions, maintenance mode and feature switches the customer app reads at start-up.",
    group: "Platform",
    permission: "settings.app",
    scopes: ["global"],
    fields: [
      { key: "minSupportedVersion", label: "Minimum supported app version", type: "version", default: "1.0.0", public: true, help: "Older apps are asked to update before they can continue." },
      { key: "latestVersion", label: "Latest app version", type: "version", default: "1.0.0", public: true },
      { key: "forceUpdate", label: "Force update to the latest version", type: "boolean", default: false, public: true },
      { key: "maintenanceMode", label: "Maintenance mode", type: "boolean", default: false, public: true, help: "Shows the maintenance message instead of the app." },
      { key: "maintenanceMessage", label: "Maintenance message", type: "text", default: "", maxLength: 200, public: true },
      { key: "homeHeadline", label: "Home headline", type: "text", default: "What are you craving today?", maxLength: 60, public: true, help: "Big line under the greeting on Home." },
      { key: "searchPlaceholder", label: "Search box hint", type: "text", default: "Search for dishes, biryani, meals...", maxLength: 60, public: true, help: "Grey text in the Home and Search boxes." },
      { key: "deliveryPromiseLabel", label: "Delivery promise shown in the app", type: "text", default: "25–35 min", maxLength: 40, public: true, help: "Onboarding: “We deliver in …”." },
      {
        key: "mealSlotsShown",
        label: "Meal slots shown in the app",
        type: "multiEnum",
        default: ["lunch"],
        options: [
          { value: "breakfast", label: "Breakfast" },
          { value: "lunch", label: "Lunch" },
          { value: "dinner", label: "Dinner" },
        ],
        public: true,
        help: "All slots exist in the backend; this only controls what the app displays.",
      },
      { key: "featurePickup", label: "Pickup (self-collect)", type: "boolean", default: false, public: true },
      { key: "featureScheduledDelivery", label: "Schedule for later", type: "boolean", default: false, public: true },
      { key: "featureReferrals", label: "Referrals", type: "boolean", default: false, public: true },
      { key: "featureWallet", label: "Wallet", type: "boolean", default: false, public: true },
      { key: "supportPhone", label: "Support phone", type: "string", default: "", maxLength: 20, public: true },
      { key: "supportEmail", label: "Support email", type: "string", default: "", maxLength: 120, public: true },
    ],
  },

  order_policy: {
    title: "Order policy",
    description: "How food orders are accepted, cancelled and paid. Set platform-wide, per city, or per kitchen.",
    group: "Orders",
    permission: "settings.policies",
    scopes: ["global", "city", "kitchen"],
    fields: [
      {
        key: "acceptMode",
        label: "Order acceptance",
        type: "enum",
        default: "manual",
        options: [
          { value: "manual", label: "Kitchen accepts each order" },
          { value: "auto", label: "Accept automatically while taking orders" },
        ],
        kitchenEditable: true,
      },
      { key: "acceptSlaMinutes", label: "Alert if not accepted within (minutes)", type: "integer", default: 5, min: 1, max: 60, kitchenEditable: true },
      { key: "autoCancelAfterMinutes", label: "Auto-cancel and refund if not accepted after (minutes)", type: "integer", default: 15, min: 0, max: 180, help: "0 means never auto-cancel." },
      { key: "unpaidOrderExpiryMinutes", label: "Cancel unpaid online orders after (minutes)", type: "integer", default: 15, min: 5, max: 60 },
      {
        key: "customerCancelPolicy",
        label: "Customer can cancel",
        type: "enum",
        default: "before_accept",
        options: [
          { value: "before_accept", label: "Until the kitchen accepts" },
          { value: "within_window", label: "Within a few minutes of placing" },
          { value: "never", label: "Never (support only)" },
        ],
      },
      { key: "customerCancelWindowMinutes", label: "Cancel window (minutes)", type: "integer", default: 2, min: 0, max: 60, help: "Used when customers can cancel within a window." },
      { key: "codEnabled", label: "Cash on delivery", type: "boolean", default: true, kitchenEditable: true },
      { key: "codMaxOrderPaise", label: "Cash on delivery limit", type: "money", default: 0, min: 0, max: 10_000_000, kitchenEditable: true, help: "0 means no limit." },
      { key: "minOrderPaise", label: "Minimum order value", type: "money", default: 0, min: 0, max: 10_000_000, kitchenEditable: true },
      { key: "pickupEnabled", label: "Allow pickup orders", type: "boolean", default: false, kitchenEditable: true },
      { key: "supportRefundLimitPaise", label: "Support can refund without approval up to", type: "money", default: 0, min: 0, max: 10_000_000, help: "Refunds above this need finance approval. 0 means every refund needs approval." },
      { key: "kitchenSteps", label: "Kitchen steps shown while preparing", type: "stringList", default: ["Preparing ingredients", "Cooking", "Plating & packing"], maxItems: 8, maxLength: 60, kitchenEditable: true, help: "Shown to the customer on the live order screen, in this order." },
      { key: "avgPrepMinutes", label: "Average preparation time (minutes)", type: "integer", default: 20, min: 5, max: 120, kitchenEditable: true },
      { key: "ratingWindowDays", label: "Customers can rate an order for (days)", type: "integer", default: 7, min: 1, max: 30 },
    ],
  },

  pricing: {
    title: "Pricing & charges",
    description: "The bill formula: delivery fee, free-delivery threshold, packaging, small-order and platform fees, surge and tips.",
    group: "Money",
    permission: "settings.pricing",
    scopes: ["global", "city", "kitchen"],
    fields: [
      {
        key: "deliveryFeeMode",
        label: "Delivery fee",
        type: "enum",
        default: "flat",
        options: [
          { value: "flat", label: "Flat fee" },
          { value: "distance_slabs", label: "By distance (slabs)" },
          { value: "provider_quote", label: "Delivery partner's quote (with markup)" },
        ],
      },
      { key: "deliveryFeePaise", label: "Flat delivery fee", type: "money", default: 4000, min: 0, max: 100_000, kitchenEditable: true },
      { key: "deliverySlabs", label: "Distance slabs", type: "slabs", default: [{ uptoKm: 2, feePaise: 2000 }, { uptoKm: 4, feePaise: 3000 }, { uptoKm: 8, feePaise: 4000 }], help: "Fee for each distance band. Beyond the last band the last fee applies." },
      { key: "quoteMarkupPercent", label: "Markup on the partner's quote (%)", type: "integer", default: 0, min: -100, max: 200, help: "Negative values subsidise delivery." },
      { key: "freeDeliveryAbovePaise", label: "Free delivery above", type: "money", default: 29_900, min: 0, max: 10_000_000, kitchenEditable: true, help: "An item total of this amount or more delivers free. 0 means never free." },
      { key: "plusFreeDelivery", label: "Free delivery for MealJi Plus members", type: "boolean", default: true },
      {
        key: "packagingMode",
        label: "Packaging charge",
        type: "enum",
        default: "per_order",
        options: [
          { value: "none", label: "None" },
          { value: "per_order", label: "Per order" },
          { value: "per_item", label: "Per item" },
          { value: "per_dish", label: "Set on each dish" },
        ],
      },
      { key: "packagingPaise", label: "Packaging charge", type: "money", default: 2000, min: 0, max: 100_000, kitchenEditable: true },
      { key: "smallOrderBelowPaise", label: "Small-order fee below", type: "money", default: 0, min: 0, max: 10_000_000, help: "0 turns the small-order fee off." },
      { key: "smallOrderFeePaise", label: "Small-order fee", type: "money", default: 0, min: 0, max: 100_000 },
      { key: "platformFeePaise", label: "Platform fee per order", type: "money", default: 0, min: 0, max: 100_000 },
      { key: "surgeEnabled", label: "Peak-hour fee", type: "boolean", default: false },
      { key: "surgeStart", label: "Peak hours start", type: "time", default: "19:00" },
      { key: "surgeEnd", label: "Peak hours end", type: "time", default: "21:00" },
      { key: "surgeFeePaise", label: "Peak-hour fee", type: "money", default: 0, min: 0, max: 100_000 },
      { key: "tipEnabled", label: "Allow tips", type: "boolean", default: false, public: true },
      { key: "tipPresetsPaise", label: "Tip amounts offered", type: "moneyList", default: [2000, 3000, 5000], maxItems: 5, public: true },
      { key: "pickupReadyMinutes", label: "Pickup ready in (minutes)", type: "integer", default: 15, min: 5, max: 120, kitchenEditable: true },
    ],
  },

  tax: {
    title: "Tax (GST)",
    description: "GST rate per charge type, HSN/SAC codes and whether menu prices include tax.",
    group: "Money",
    permission: "settings.tax",
    scopes: ["global", "city", "kitchen"],
    fields: [
      { key: "pricesIncludeTax", label: "Menu prices include GST", type: "boolean", default: false },
      { key: "foodGstPercent", label: "GST on food (%)", type: "decimal", default: 5, min: 0, max: 28, money: true },
      { key: "deliveryGstPercent", label: "GST on delivery fee (%)", type: "decimal", default: 18, min: 0, max: 28, money: true },
      { key: "packagingGstPercent", label: "GST on packaging (%)", type: "decimal", default: 5, min: 0, max: 28, money: true },
      { key: "platformFeeGstPercent", label: "GST on platform and other fees (%)", type: "decimal", default: 18, min: 0, max: 28, money: true },
      { key: "foodSac", label: "SAC for food (restaurant service)", type: "string", default: "996331", maxLength: 10 },
      { key: "deliverySac", label: "SAC for delivery", type: "string", default: "996813", maxLength: 10 },
      {
        key: "supplyRule",
        label: "CGST + SGST or IGST",
        type: "enum",
        default: "place_of_supply",
        options: [
          { value: "place_of_supply", label: "By place of supply (IGST when the customer's state differs)" },
          { value: "always_intra", label: "Always CGST + SGST" },
        ],
      },
    ],
  },

  delivery: {
    title: "Delivery",
    description: "Which delivery partner books riders, when, and what happens when a booking fails.",
    group: "Orders",
    permission: "settings.delivery",
    scopes: ["global", "city", "kitchen"],
    fields: [
      {
        key: "provider",
        label: "Delivery partner",
        type: "enum",
        default: "manual",
        options: [
          { value: "manual", label: "Manual (kitchen hands over and updates the rider)" },
          { value: "self", label: "Kitchen delivers itself" },
          { value: "auto", label: "Best available partner (compare quotes)" },
        ],
        help: "More partners appear here once their accounts are added.",
      },
      {
        key: "autoSelect",
        label: "When comparing partners, prefer",
        type: "enum",
        default: "cheapest",
        options: [
          { value: "cheapest", label: "The cheapest quote" },
          { value: "fastest", label: "The fastest pickup" },
        ],
      },
      { key: "autoBook", label: "Book a rider automatically", type: "boolean", default: true },
      {
        key: "bookAt",
        label: "Book the rider when",
        type: "enum",
        default: "ready",
        options: [
          { value: "accepted", label: "The kitchen accepts (plus the offset)" },
          { value: "ready", label: "The food is ready" },
        ],
      },
      { key: "bookOffsetMinutes", label: "Offset after accept (minutes)", type: "integer", default: 10, min: 0, max: 120 },
      { key: "rebookAttempts", label: "Re-book attempts when a rider cancels", type: "integer", default: 2, min: 0, max: 10 },
      { key: "selfDeliveryAllowed", label: "Kitchen may deliver itself as a fallback", type: "boolean", default: true },
      {
        key: "costBorneBy",
        label: "Delivery cost is paid by",
        type: "enum",
        default: "platform",
        options: [
          { value: "platform", label: "MealJi" },
          { value: "kitchen", label: "The kitchen" },
        ],
      },
      { key: "minutesPerKm", label: "Travel minutes per km (ETA)", type: "integer", default: 4, min: 1, max: 20 },
      { key: "etaBufferMinutes", label: "ETA buffer (minutes)", type: "integer", default: 5, min: 0, max: 60, kitchenEditable: true },
    ],
  },

  menu_policy: {
    title: "Menu policy",
    description: "What kitchens may change on their own menu and which changes wait for platform approval.",
    group: "Kitchens",
    permission: "settings.policies",
    scopes: ["global", "kitchen"],
    fields: [
      {
        key: "menuChangeApproval",
        label: "Kitchen menu changes need approval",
        type: "enum",
        default: "none",
        options: [
          { value: "none", label: "Never" },
          { value: "new_items", label: "New dishes" },
          { value: "price_changes", label: "Price changes" },
          { value: "all", label: "Every change" },
        ],
      },
      { key: "kitchenCanCreateDishes", label: "Kitchens may add their own dishes", type: "boolean", default: true },
      { key: "maxDishImages", label: "Images per dish", type: "integer", default: 5, min: 1, max: 10 },
      { key: "kitchenFundedOffers", label: "Kitchens may run their own offers", type: "boolean", default: false },
      { key: "kitchenAnnouncements", label: "Kitchens may message their own customers (after approval)", type: "boolean", default: false },
    ],
  },

  subscription_policy: {
    title: "Subscription rules",
    description: "MealJi Plus lifecycle: grace periods, reminders, pause and shift limits, renewal retries.",
    group: "Subscriptions",
    permission: "settings.subscriptions",
    scopes: ["global", "city", "kitchen"],
    fields: [
      { key: "unpaidCheckoutExpiryHours", label: "Cancel an unpaid subscription checkout after (hours)", type: "integer", default: 24, min: 1, max: 168 },
      { key: "graceDays", label: "Grace period after a failed renewal (days)", type: "integer", default: 3, min: 0, max: 15 },
      { key: "renewalRetryCount", label: "Renewal retries", type: "integer", default: 3, min: 0, max: 10 },
      { key: "reminderDaysBefore", label: "Send renewal reminders (days before)", type: "moneyList", default: [3, 1], maxItems: 4, help: "Each number is a day count, e.g. 3 and 1." },
      { key: "pauseMinMonths", label: "Shortest pause (months)", type: "integer", default: 1, min: 1, max: 12 },
      { key: "pauseMaxMonths", label: "Longest pause (months)", type: "integer", default: 3, min: 1, max: 12 },
      {
        key: "pauseStarts",
        label: "A pause starts",
        type: "enum",
        default: "cycle_end",
        options: [
          { value: "cycle_end", label: "At the end of the current cycle" },
          { value: "next_day", label: "From the next day" },
        ],
      },
      {
        key: "planChangeTiming",
        label: "Plan changes apply",
        type: "enum",
        default: "next_cycle",
        options: [
          { value: "next_cycle", label: "From the next billing date (no proration)" },
          { value: "immediately", label: "Immediately" },
        ],
      },
      { key: "allowCancelUndo", label: "Customers can undo a cancellation", type: "boolean", default: true },
      { key: "selectionReminderMinutes", label: "Remind to pick meals before cutoff (minutes)", type: "moneyList", default: [120, 30], maxItems: 4 },
      { key: "cancelReasons", label: "Cancellation reasons offered", type: "stringList", default: ["Too expensive", "Food quality", "Delivery issues", "Moving to a new place", "Cooking at home", "Other"], maxItems: 10, maxLength: 60, public: true },
      { key: "preDebitNoticeHours", label: "Pre-debit notice before autopay (hours)", type: "integer", default: 24, min: 24, max: 72 },
      { key: "mealDropProvider", label: "Meal drops are delivered by", type: "enum", default: "manual", options: [{ value: "manual", label: "Manual (kitchen riders)" }, { value: "self", label: "Kitchen delivers itself" }] },
    ],
  },

  loyalty: {
    title: "Loyalty & referrals",
    description: "Points earned per action, point value, expiry, tiers and referral rewards.",
    group: "Engagement",
    permission: "settings.loyalty",
    scopes: ["global"],
    fields: [
      { key: "enabled", label: "Points programme on", type: "boolean", default: true, public: true },
      { key: "pointsPerOrder", label: "Points per delivered order", type: "integer", default: 50, min: 0, max: 10_000 },
      { key: "pointsPerReview", label: "Points per rating", type: "integer", default: 100, min: 0, max: 10_000 },
      { key: "pointsReferral", label: "Referral points (each side)", type: "integer", default: 200, min: 0, max: 10_000 },
      { key: "pointsBirthday", label: "Birthday points", type: "integer", default: 250, min: 0, max: 10_000 },
      { key: "pointValuePaise", label: "Value of one point", type: "money", default: 25, min: 0, max: 10_000, public: true, help: "Used for redemption at checkout and liability reports." },
      { key: "maxRedeemPercent", label: "Points can pay up to (% of the bill)", type: "integer", default: 20, min: 0, max: 100, public: true },
      { key: "expiryMonths", label: "Points expire after (months)", type: "integer", default: 12, min: 0, max: 60, help: "0 means points never expire." },
      { key: "tierNames", label: "Tiers (lowest first)", type: "stringList", default: ["Spice Bronze", "Silver Tandoor", "Gold Kadai", "Black Makhani"], maxItems: 6, public: true },
      { key: "tierThresholds", label: "Lifetime points needed per tier", type: "moneyList", default: [0, 1000, 3000, 7500], maxItems: 6, help: "One number per tier, same order." },
      { key: "referralRequiresDelivery", label: "Referral pays out after the friend's first delivered order", type: "boolean", default: true },
    ],
  },

  notification_policy: {
    title: "Notifications & marketing",
    description: "Quiet hours, frequency caps, approvals and channel fallbacks for messages.",
    group: "Engagement",
    permission: "settings.notifications",
    scopes: ["global"],
    fields: [
      { key: "quietStart", label: "Marketing quiet hours start", type: "time", default: "21:00" },
      { key: "quietEnd", label: "Marketing quiet hours end", type: "time", default: "09:00" },
      { key: "promoSmsStart", label: "Promotional SMS allowed from", type: "time", default: "10:00" },
      { key: "promoSmsEnd", label: "Promotional SMS allowed until", type: "time", default: "21:00" },
      { key: "capPushPerDay", label: "Marketing push per person per day", type: "integer", default: 1, min: 0, max: 20 },
      { key: "capPushPerWeek", label: "Marketing push per person per week", type: "integer", default: 4, min: 0, max: 50 },
      { key: "capWhatsappPerWeek", label: "Marketing WhatsApp per person per week", type: "integer", default: 2, min: 0, max: 20 },
      { key: "capEmailPerWeek", label: "Marketing email per person per week", type: "integer", default: 3, min: 0, max: 20 },
      { key: "campaignApprovalAbove", label: "Campaigns need approval above (people)", type: "integer", default: 1000, min: 0, max: 10_000_000, help: "0 means every campaign needs approval." },
      { key: "transactionalFallback", label: "Transactional channel order", type: "stringList", default: ["push", "whatsapp", "sms"], maxItems: 5, help: "Tried in order until one reaches the person." },
    ],
  },

  support: {
    title: "Support contacts",
    description: "Phone, email, WhatsApp, hours and response times shown on the support screens.",
    group: "Platform",
    permission: "support.manage",
    scopes: ["global"],
    fields: [
      { key: "phone", label: "Support phone", type: "string", default: "", maxLength: 20, public: true },
      { key: "phoneHours", label: "Phone hours", type: "string", default: "9 AM – 11 PM", maxLength: 60, public: true },
      { key: "email", label: "Support email", type: "string", default: "", maxLength: 120, public: true },
      { key: "emailSla", label: "Email reply time", type: "string", default: "Within 24 hours", maxLength: 60, public: true },
      { key: "whatsapp", label: "WhatsApp number", type: "string", default: "", maxLength: 20, public: true },
      { key: "chatEnabled", label: "Chat enabled", type: "boolean", default: false, public: true },
      { key: "chatEtaMinutes", label: "Chat reply time (minutes)", type: "integer", default: 5, min: 1, max: 240, public: true },
      { key: "ticketSlaHours", label: "Ticket resolution target (hours)", type: "integer", default: 24, min: 1, max: 240 },
      { key: "grievanceOfficer", label: "Grievance officer (DPDP)", type: "string", default: "", maxLength: 120, public: true },
    ],
  },
};

export function getDefinition(key) {
  return SETTING_DEFINITIONS[key] || null;
}

export function listDefinitions() {
  return Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => ({ key, ...definition }));
}
