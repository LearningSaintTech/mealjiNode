// Tracking plan v1: the event names the app (client) and the server may send,
// with the properties each must carry. Versioned with the code; unknown events
// are rejected outside production and counted (not stored) in production.

export const TRACKING_PLAN_VERSION = 1;

const E = (required = [], source = "client") => ({ required, source });

export const EVENT_SCHEMA = {
  // App lifecycle
  app_installed: E(),
  app_opened: E(),
  session_started: E(),
  session_ended: E(),
  screen_viewed: E(["screen"]),
  app_updated: E(),
  force_update_shown: E(),
  // Onboarding & auth
  onboarding_step_viewed: E(["step"]),
  onboarding_skipped: E(),
  login_phone_submitted: E(),
  otp_requested: E(),
  otp_resent: E(),
  otp_verified: E(),
  otp_failed: E(),
  profile_completed: E(),
  // Location
  location_permission_prompted: E(),
  location_permission_granted: E(),
  location_permission_denied: E(),
  address_searched: E(),
  serviceability_checked: E(["serviceable"]),
  not_serviceable_shown: E(),
  address_added: E(),
  // Discovery
  home_viewed: E(),
  banner_viewed: E(["bannerId"]),
  banner_clicked: E(["bannerId"]),
  veg_toggle_changed: E(),
  filter_applied: E(),
  category_viewed: E(["categoryId"]),
  menu_viewed: E(),
  dish_viewed: E(["dishId"]),
  combo_viewed: E(["comboId"]),
  search_performed: E(["query"]),
  search_zero_results: E(["query"]),
  search_result_clicked: E(),
  favorite_added: E(["dishId"]),
  favorite_removed: E(["dishId"]),
  // Cart & checkout
  add_to_cart: E(["dishId"]),
  remove_from_cart: E(),
  cart_viewed: E(),
  coupon_applied: E(["code"]),
  coupon_failed: E(["code"]),
  checkout_started: E(),
  address_selected: E(),
  delivery_option_selected: E(),
  payment_method_selected: E(["method"]),
  payment_initiated: E(),
  // Orders (client side)
  order_tracked: E(["orderId"]),
  reorder_clicked: E(["orderId"]),
  // Subscription (client side)
  plan_list_viewed: E(),
  plan_viewed: E(["planCode"]),
  plan_checkout_started: E(["planCode"]),
  meal_slot_viewed: E(),
  meal_item_added: E(),
  meal_selection_confirmed: E(["date", "slot"]),
  meal_modified: E(),
  subscription_pause_requested: E(),
  cancel_flow_started: E(),
  cancel_reason_selected: E(["reasonId"]),
  pause_instead_chosen: E(),
  plan_change_previewed: E(),
  // Rewards & referrals
  rewards_viewed: E(),
  referral_link_shared: E(),
  referral_installed: E(),
  // Notifications
  push_permission_prompted: E(),
  push_permission_granted: E(),
  push_permission_denied: E(),
  notification_received: E(),
  notification_opened: E(),
  inbox_viewed: E(),
  inapp_message_shown: E(["messageId"]),
  inapp_message_clicked: E(["messageId"]),
  inapp_message_dismissed: E(["messageId"]),
  notification_preferences_changed: E(),
  // Support
  support_viewed: E(),
  faq_viewed: E(["faqId"]),
  chat_started: E(),
  // Errors & performance
  api_error: E(["endpoint"]),
  screen_load_time: E(["screen"]),
  experiment_exposed: E(["experimentKey", "variant"]),

  // Server events (authoritative for money; never accepted from the client)
  user_registered: E([], "server"),
  order_placed: E(["orderId"], "server"),
  payment_succeeded: E([], "server"),
  payment_failed: E([], "server"),
  order_accepted: E(["orderId"], "server"),
  order_prepared: E(["orderId"], "server"),
  order_dispatched: E(["orderId"], "server"),
  order_delivered: E(["orderId"], "server"),
  order_cancelled: E(["orderId"], "server"),
  rating_submitted: E(["orderId"], "server"),
  subscription_purchased: E([], "server"),
  subscription_renewed: E([], "server"),
  subscription_renewal_failed: E([], "server"),
  subscription_paused: E([], "server"),
  subscription_resumed: E([], "server"),
  subscription_cancelled: E([], "server"),
  cancel_undone: E([], "server"),
  meal_shifted: E([], "server"),
  points_earned: E([], "server"),
  reward_redeemed: E([], "server"),
  referral_converted: E([], "server"),
  ticket_created: E([], "server"),
};

export function validateEvent(event, { source = "client" } = {}) {
  const schema = EVENT_SCHEMA[event?.name];
  if (!schema) return `Unknown event "${event?.name}"`;
  if (source === "client" && schema.source === "server") return `"${event.name}" is recorded by the server`;
  const props = event.properties || {};
  const missing = schema.required.filter((key) => props[key] === undefined || props[key] === null || props[key] === "");
  return missing.length ? `"${event.name}" needs ${missing.join(", ")}` : null;
}
