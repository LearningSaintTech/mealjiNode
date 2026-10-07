// The permission catalogue. Platform keys are held by platform staff roles;
// keys starting with `kitchen.` are held by kitchen roles and always act on the
// holder's own kitchen. Roles are data: the seed creates the system roles below
// and the console can edit their permissions or create custom roles.

const P = (key, module, description) => ({ key, module, description });

export const PERMISSIONS = [
  // People & access
  P("users.read", "users", "List and view users and customers"),
  P("users.update_status", "users", "Activate or suspend users"),
  P("staff.create", "staff", "Invite platform staff"),
  P("staff.update_role", "staff", "Change a platform staff member's role"),
  P("roles.read", "roles", "List roles and their permissions"),
  P("roles.manage", "roles", "Create custom roles and attach or detach permissions"),
  P("permissions.read", "permissions", "List the permission catalog"),
  P("audit.read", "audit", "View the audit log of admin and kitchen changes"),

  // Settings centre
  P("settings.read", "settings", "View platform settings and their history"),
  P("settings.app", "settings", "Change app versions, maintenance mode and feature switches"),
  P("settings.policies", "settings", "Change order policies platform-wide, per city or per kitchen"),
  P("settings.pricing", "settings", "Change delivery fees, packaging, tips and other charges"),
  P("settings.tax", "settings", "Change GST rates, HSN/SAC codes and tax rules"),
  P("settings.billing_entities", "settings", "Manage invoicing entities (GSTIN, FSSAI, invoice series) and kitchen mapping"),
  P("settings.delivery", "settings", "Manage delivery partners, default providers and booking rules"),
  P("settings.subscriptions", "settings", "Change subscription lifecycle rules and meal slot limits"),
  P("settings.loyalty", "settings", "Change points, tiers, referral and expiry rules"),
  P("settings.notifications", "settings", "Change quiet hours, frequency caps and channel fallbacks"),

  // Kitchens & menu
  P("kitchens.read", "kitchens", "List and view kitchens"),
  P("kitchens.manage", "kitchens", "Onboard kitchens and change their status, zone and admin"),
  P("master_menu.manage", "menu", "Maintain the master dish library"),
  P("menu.manage", "menu", "Edit any kitchen's menu"),
  P("menu_changes.approve", "menu", "Approve or reject kitchen menu changes"),
  P("content.manage", "content", "Manage banners, home sections, onboarding slides and pages"),

  // Orders, money & delivery
  P("orders.read", "orders", "Search and view orders"),
  P("orders.manage", "orders", "Change order status and cancel orders"),
  P("refunds.create", "orders", "Start a refund (above the support limit it waits for approval)"),
  P("refunds.approve", "orders", "Approve refunds above the support limit"),
  P("payments.read", "payments", "View payments, settlements and reconciliation"),
  P("invoices.read", "payments", "View and download invoices"),
  P("delivery.manage", "delivery", "View delivery jobs and book, re-book or cancel deliveries"),

  // Subscriptions
  P("plans.manage", "subscriptions", "Create, edit and retire subscription plans"),
  P("subscriptions.read", "subscriptions", "View subscriptions, meal selections and production sheets"),
  P("subscriptions.manage", "subscriptions", "Pause, resume, cancel or extend subscriptions on a customer's behalf"),

  // Loyalty, offers & support
  P("coupons.manage", "offers", "Create and manage coupons"),
  P("rewards.manage", "loyalty", "Manage the reward catalogue, tiers and manual point adjustments"),
  P("referrals.read", "loyalty", "View referrals"),
  P("support.manage", "support", "Manage FAQs, support contacts, categories and canned replies"),
  P("tickets.handle", "support", "Work the support ticket queue"),

  // Engagement
  P("templates.manage", "engagement", "Manage notification templates"),
  P("segments.manage", "engagement", "Build and import audience segments"),
  P("campaigns.manage", "engagement", "Create and schedule campaigns"),
  P("campaigns.approve", "engagement", "Approve campaigns before they send"),
  P("journeys.manage", "engagement", "Build and switch automated journeys"),
  P("notifications.send", "engagement", "Send a one-off notification to a person or small list"),
  P("messages.read", "engagement", "Search the message delivery log"),
  P("experiments.manage", "engagement", "Create and stop experiments"),

  // Insight
  P("analytics.read", "analytics", "View dashboards"),
  P("reports.read", "reports", "Run operational reports"),
  P("reports.finance", "reports", "Run finance reports (payments, GST, invoices, liability)"),
  P("reports.export", "reports", "Export reports to CSV"),
  P("reports.schedule", "reports", "Schedule reports to be emailed"),

  // Kitchen console (always the holder's own kitchen)
  P("kitchen.desk", "kitchen", "Open the signed-in kitchen panel"),
  P("kitchen.configure", "kitchen", "Update this kitchen's place, hours, holidays and service note"),
  P("kitchen.team", "kitchen", "Invite and suspend kitchen team members"),
  P("kitchen.roles", "kitchen", "Create kitchen roles for the team from allowed permissions"),
  P("kitchen.settings", "kitchen", "Change this kitchen's own policies within platform limits"),
  P("kitchen.orders", "kitchen", "Work the live order desk"),
  P("kitchen.menu", "kitchen", "Edit this kitchen's menu"),
  P("kitchen.menu.prices", "kitchen", "Change dish and option prices"),
  P("kitchen.availability", "kitchen", "Mark dishes sold out or back in stock"),
  P("kitchen.delivery", "kitchen", "Hand orders to riders and update delivery status"),
  P("kitchen.slots", "kitchen", "Set meal slots, cutoffs and daily slot menus"),
  P("kitchen.production", "kitchen", "View production sheets and dispatch checklists"),
  P("kitchen.reports", "kitchen", "View this kitchen's reports"),
];

const keysOf = (predicate) => PERMISSIONS.filter(predicate).map((permission) => permission.key);
export const PLATFORM_PERMISSIONS = keysOf((permission) => !permission.key.startsWith("kitchen."));
export const KITCHEN_PERMISSIONS = keysOf((permission) => permission.key.startsWith("kitchen."));

export const ROLE_GRANTS = {
  superadmin: PLATFORM_PERMISSIONS,
  subadmin: ["users.read", "users.update_status", "orders.read", "kitchens.read"],
  ops_manager: [
    "kitchens.read", "orders.read", "orders.manage", "refunds.create", "delivery.manage", "menu.manage",
    "menu_changes.approve", "subscriptions.read", "reports.read", "analytics.read", "users.read", "audit.read",
  ],
  marketing_manager: [
    "templates.manage", "segments.manage", "campaigns.manage", "journeys.manage", "content.manage", "coupons.manage",
    "notifications.send", "messages.read", "experiments.manage", "reports.read", "analytics.read", "users.read",
  ],
  finance: [
    "payments.read", "invoices.read", "refunds.create", "refunds.approve", "orders.read", "subscriptions.read",
    "reports.read", "reports.finance", "reports.export", "settings.read", "settings.tax", "settings.billing_entities",
  ],
  support_agent: ["users.read", "orders.read", "refunds.create", "tickets.handle", "messages.read", "subscriptions.read"],
  analyst: ["analytics.read", "reports.read", "reports.export", "kitchens.read"],
  kitchen_admin: KITCHEN_PERMISSIONS,
  kitchen_subadmin: ["kitchen.desk", "kitchen.orders", "kitchen.availability", "kitchen.delivery", "kitchen.production"],
  user: [],
};

// `scope` decides which console a role signs in to and which permissions it can hold.
export const ROLE_META = {
  superadmin: { name: "Super admin", scope: "platform", description: "Platform owner. Onboards kitchens and invites platform staff" },
  subadmin: { name: "Subadmin", scope: "platform", description: "Platform subadmin. Monitors people and account status" },
  ops_manager: { name: "Ops manager", scope: "platform", description: "Runs orders, kitchens, menus and deliveries" },
  marketing_manager: { name: "Marketing manager", scope: "platform", description: "Runs campaigns, journeys, content and offers" },
  finance: { name: "Finance", scope: "platform", description: "Payments, refunds approval, invoices and GST" },
  support_agent: { name: "Support agent", scope: "platform", description: "Customer tickets, order lookups and small refunds" },
  analyst: { name: "Analyst", scope: "platform", description: "Dashboards and reports, read only" },
  kitchen_admin: { name: "Kitchen admin", scope: "kitchen", description: "Runs one kitchen and its team" },
  kitchen_subadmin: { name: "Kitchen subadmin", scope: "kitchen", description: "Works the kitchen desk for one kitchen" },
  user: { name: "User", scope: "customer", description: "Customer account" },
};

export const SYSTEM_ROLES = Object.keys(ROLE_META);
export const STAFF_ROLES = SYSTEM_ROLES.filter((slug) => ROLE_META[slug].scope === "platform");
export const KITCHEN_ROLES = SYSTEM_ROLES.filter((slug) => ROLE_META[slug].scope === "kitchen");
export const CONSOLE_ROLES = [...STAFF_ROLES, ...KITCHEN_ROLES];
export const ALL_ROLES = [...SYSTEM_ROLES];

// Removing these would lock the role out of its own screens.
export const LOCKED_GRANTS = {
  superadmin: ["roles.read", "roles.manage"],
  kitchen_admin: ["kitchen.desk", "kitchen.team"],
  kitchen_subadmin: ["kitchen.desk"],
};

// roles.manage stays with the super admin so no other role can grant itself more access.
const SUPERADMIN_ONLY = ["roles.manage"];

/** The scope of a role document or slug: platform, kitchen or customer. */
export function roleScope(role) {
  if (!role) return "customer";
  if (typeof role === "string") return ROLE_META[role]?.scope || scopeFromSlug(role);
  return role.scope || ROLE_META[role.slug]?.scope || scopeFromSlug(role.slug);
}

// Custom role slugs carry their scope as a prefix (`kitchen_…`, `staff_…`), so
// a slug alone (e.g. stored on an audit entry) still tells the console apart.
function scopeFromSlug(slug) {
  if (String(slug || "").startsWith("kitchen_")) return "kitchen";
  if (String(slug || "").startsWith("staff_")) return "platform";
  return "customer";
}

export function isPlatformRole(role) {
  return roleScope(role) === "platform";
}

export function isKitchenRole(role) {
  return roleScope(role) === "kitchen";
}

export function isConsoleRole(role) {
  return isPlatformRole(role) || isKitchenRole(role);
}

/** Permission keys a role may hold. Accepts a slug or a role document. */
export function assignablePermissions(role) {
  const slug = typeof role === "string" ? role : role?.slug;
  const scope = roleScope(role);
  if (slug === "superadmin") return PLATFORM_PERMISSIONS;
  if (scope === "platform") return PLATFORM_PERMISSIONS.filter((key) => !SUPERADMIN_ONLY.includes(key));
  if (scope === "kitchen") return KITCHEN_PERMISSIONS;
  return [];
}
