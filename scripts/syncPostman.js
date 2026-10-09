// Adds every mounted route that the Postman collection does not have yet,
// grouped into folders by area, with example bodies for the main flows.
// Existing requests (and their hand-written descriptions) are left untouched.
// Usage: npm run postman:sync && npm run postman:check

process.env.LOG_PRETTY = "false";

const crypto = await import("node:crypto");
const { readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { collectPostman, mountedRoutes, normalizePath } = await import("./routeList.js");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectionPath = path.join(rootDir, "postman", "mealJiNode.postman_collection.json");

// Folder per area: [matcher on the path after /api/v1, folder name].
const FOLDERS = [
  [/^\/webhooks/, "Webhooks"],
  [/^\/uploads/, "Uploads"],
  [/^\/admin\/kitchens\/:param\/menu/, "Admin · Kitchen menus"],
  [/^\/admin\/(master-|menu-change)/, "Admin · Master menu & approvals"],
  [/^\/admin\/(banners|onboarding-slides|home-sections|kitchens\/:param\/about)/, "Admin · Content"],
  [/^\/admin\/(orders|deliveries|delivery-providers)/, "Admin · Orders & delivery"],
  [/^\/admin\/(payments|refunds)/, "Admin · Payments & refunds"],
  [/^\/admin\/(billing-entities|invoices|kitchens\/:param\/billing-entity)/, "Admin · Invoicing"],
  [/^\/admin\/(subscription-plans|subscriptions|meal-slots|meal-plan)/, "Admin · Subscriptions"],
  [/^\/admin\/(rewards|referrals|coupons|users\/:param\/points)/, "Admin · Loyalty & offers"],
  [/^\/admin\/support/, "Admin · Support"],
  [/^\/admin\/search/, "Admin · Search"],
  [/^\/admin\/(segments|campaigns|journeys|in-app-messages|traits|users\/:param\/(consents|traits)|notification-templates|notifications|messages)/, "Admin · Engagement"],
  [/^\/admin\/experiments/, "Admin · Experiments"],
  [/^\/admin\/analytics/, "Admin · Analytics"],
  [/^\/admin\/reports/, "Admin · Reports"],
  [/^\/admin\/(settings)/, "Settings"],
  [/^\/admin/, "Admin"],
  [/^\/kitchen\/menu/, "Kitchen · Menu"],
  [/^\/kitchen\/orders/, "Kitchen · Orders"],
  [/^\/kitchen\/(slots|slot-menus|meal-plan|meals)/, "Kitchen · Meal plan"],
  [/^\/kitchen\/reports/, "Kitchen · Reports"],
  [/^\/kitchen/, "Kitchen desk"],
  [/^\/users\/me\/(addresses)/, "App · Addresses"],
  [/^\/users\/me\/favorites/, "App · Favourites"],
  [/^\/users/, "App · Profile"],
  [/^\/(geo|serviceability)/, "App · Location"],
  [/^\/(home|onboarding|kitchen-about|banners|in-app-messages)/, "App · Home & content"],
  [/^\/(menu|combos|dishes|search)/, "App · Menu & search"],
  [/^\/(cart|promos|checkout|delivery)/, "App · Cart & checkout"],
  [/^\/(orders|payments|invoices|payment-methods|wallet)/, "App · Orders & payments"],
  [/^\/(subscription-plans|subscriptions)/, "App · MealJi Plus"],
  [/^\/(rewards|referrals)/, "App · Rewards"],
  [/^\/(notifications|devices)/, "App · Notifications"],
  [/^\/support/, "App · Support"],
  [/^\/(analytics|experiments|app)/, "App · Config & analytics"],
  [/^\/(u|r)\//, "Public links"],
];

// Example bodies for the main flows (others get {} to fill in).
const BODIES = {
  "POST /api/v1/cart/items": { dishId: "{{dishId}}", qty: 1, optionIds: [], specialInstructions: "Less spicy" },
  "PATCH /api/v1/cart": { addressId: "{{addressId}}", tipPaise: 2000, usePoints: false, deliveryMode: "delivery" },
  "POST /api/v1/cart/promo": { code: "WELCOME50" },
  "POST /api/v1/checkout/summary": { addressId: "{{addressId}}", deliveryMode: "delivery", paymentMethod: "upi" },
  "POST /api/v1/orders": { paymentMethod: "upi", addressId: "{{addressId}}", deliveryMode: "delivery", tipPaise: 0, usePoints: false },
  "POST /api/v1/orders/:param/rating": { foodRating: 5, deliveryRating: 4, tags: ["tasty"], comment: "Loved it" },
  "PATCH /api/v1/orders/:param/cancel": { reason: "Ordered by mistake" },
  "POST /api/v1/payments/verify": { gatewayOrderId: "{{gatewayOrderId}}", gatewayPaymentId: "pay_xxx", signature: "hmac" },
  "POST /api/v1/payments/test/complete": { gatewayOrderId: "{{gatewayOrderId}}", outcome: "success" },
  "POST /api/v1/users/me/addresses": { label: "home", houseFlat: "Flat 3B", street: "5th Cross", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", latitude: 12.936, longitude: 77.625 },
  "PATCH /api/v1/users/me": { name: "Rahul Sharma", email: "rahul@example.com", dob: "1995-08-14", gender: "male" },
  "PATCH /api/v1/users/me/preferences": { vegOnly: false, channels: { whatsapp: true }, topics: { offers: true } },
  "POST /api/v1/users/me/phone/otp": { phoneNumber: "9876543210" },
  "POST /api/v1/users/me/phone/verify": { phoneNumber: "9876543210", otp: "{{otp}}" },
  "POST /api/v1/users/me/favorites": { dishId: "{{dishId}}" },
  "POST /api/v1/uploads/presign": { purpose: "avatar", contentType: "image/jpeg", size: 120000 },
  "POST /api/v1/devices": { deviceId: "{{deviceId}}", fcmToken: "fcm-token", platform: "android", appVersion: "1.0.0" },
  "POST /api/v1/analytics/events": { events: [{ name: "app_opened", properties: {} }, { name: "dish_viewed", properties: { dishId: "{{dishId}}" } }] },
  "POST /api/v1/subscriptions/checkout": { planCode: "LUNCH30", billingMethod: "link", addressId: "{{addressId}}" },
  "PUT /api/v1/subscriptions/me/days/:param/slots/:param/selection": { items: [{ dishId: "{{dishId}}", qty: 1 }] },
  "POST /api/v1/subscriptions/me/shift": { date: "2026-10-10", slot: "lunch" },
  "POST /api/v1/subscriptions/me/pause": { months: 1 },
  "POST /api/v1/subscriptions/me/cancel": { reasonId: "r1", comment: "Travelling" },
  "POST /api/v1/subscriptions/me/change-plan": { planCode: "PLUS30" },
  "PATCH /api/v1/subscriptions/me/payment-method": { billingMethod: "autopay" },
  "POST /api/v1/referrals/apply": { code: "RAHU1A2B" },
  "POST /api/v1/support/tickets": { category: "order", issueType: "Late delivery", orderId: "{{orderId}}", description: "My order arrived 40 minutes late." },
  "POST /api/v1/support/tickets/:param/messages": { body: "Any update?" },
  "POST /api/v1/support/tickets/:param/csat": { rating: 5 },
  "POST /api/v1/payment-methods": { paymentId: "{{paymentId}}", makeDefault: true },
  "POST /api/v1/kitchen/menu/categories": { name: "Mains", subtitle: "Home-style curries" },
  "POST /api/v1/kitchen/menu/dishes": { name: "Paneer Butter Masala", categoryId: "{{categoryId}}", pricePaise: 24900, originalPricePaise: 27900, isVeg: true, description: "Rich tomato gravy", customizationGroups: [{ name: "Spice", minSelect: 1, maxSelect: 1, options: [{ name: "Mild" }, { name: "Hot", pricePaise: 1000 }] }] },
  "PATCH /api/v1/kitchen/menu/dishes/:param/availability": { isAvailable: false },
  "POST /api/v1/kitchen/menu/combos": { title: "Thali for two", pricePaise: 49900, items: [{ dishId: "{{dishId}}", qty: 2 }] },
  "POST /api/v1/kitchen/menu/import-master": { masterDishIds: ["{{masterDishId}}"], categoryId: "{{categoryId}}" },
  "PATCH /api/v1/kitchen/orders/:param/status": { status: "accepted" },
  "PATCH /api/v1/kitchen/orders/:param/step": { stepKey: "step_1", state: "done" },
  "PATCH /api/v1/kitchen/orders/:param/delivery": { action: "assign_rider", rider: { name: "Ramesh", phone: "9876543210", vehicleNumber: "KA01AB1234" } },
  "POST /api/v1/kitchen/orders/:param/rider-location": { lat: 12.935, lng: 77.62 },
  "PUT /api/v1/kitchen/schedule": { weeklyHours: [{ weekday: 0, closed: true }], closures: [{ date: "2026-11-01", reason: "Diwali" }] },
  "PUT /api/v1/kitchen/slots/:param": { windowStart: "12:00", windowEnd: "14:30", cutoffDay: "same_day", cutoffTime: "10:00", prepStart: "10:30", dispatchTime: "12:00", capacity: 0 },
  "PUT /api/v1/kitchen/slot-menus": { slot: "lunch", weekday: 1, dishIds: ["{{dishId}}"], defaultDishIds: ["{{dishId}}"] },
  "POST /api/v1/kitchen/meal-plan/dispatch": { date: "2026-10-10", slot: "lunch" },
  "POST /api/v1/kitchen/roles": { name: "Cashier", permissions: ["kitchen.orders", "kitchen.availability"] },
  "POST /api/v1/kitchen/offers": { code: "KITCHEN10", title: "10% off", type: "percent", value: 10, maxDiscountPaise: 5000 },
  "POST /api/v1/admin/roles": { name: "City ops – Bengaluru", scope: "platform", permissions: ["orders.read", "orders.manage", "kitchens.read"] },
  "POST /api/v1/admin/billing-entities": { legalName: "MealJi Foods Pvt Ltd", addressLine: "12 4th Block", city: "Bengaluru", state: "Karnataka", stateCode: "29", invoicePrefix: "MJBLR", gstin: "29ABCDE1234F1Z5" },
  "PUT /api/v1/admin/kitchens/:param/billing-entity": { entityId: "{{entityId}}" },
  "PUT /api/v1/admin/settings/:param/limits": { fields: { deliveryFeePaise: { kitchenEditable: true, max: 6000 } } },
  "POST /api/v1/admin/orders/:param/cancel": { reason: "Kitchen out of stock", refund: "full" },
  "POST /api/v1/admin/orders/:param/refunds": { amountPaise: 5000, reason: "Missing item" },
  "POST /api/v1/admin/refunds/:param/:param": { note: "Approved" },
  "POST /api/v1/admin/coupons": { code: "WELCOME50", title: "₹50 off your first order", type: "flat", value: 5000, minOrderPaise: 19900, firstOrderOnly: true, perUserLimit: 1 },
  "POST /api/v1/admin/banners": { placement: "home_hero", title: "Monsoon specials", subtitle: "Hot & fresh", ctaLabel: "Order now", deepLink: "mealji://menu" },
  "PUT /api/v1/admin/home-sections": { sections: [{ key: "hero", type: "banners", config: { placement: "home_hero" } }, { key: "popular", type: "popular", title: "Popular today" }] },
  "POST /api/v1/admin/subscription-plans": { code: "LUNCH30", name: "Lunch Monthly", pricePaise: 349900, cycleDays: 30, slots: ["lunch"], maxItemsPerMeal: 3, billingMethods: ["autopay", "link"], activeDays: [1, 2, 3, 4, 5, 6] },
  "POST /api/v1/admin/subscription-plans/:param/status": { status: "active" },
  "POST /api/v1/admin/subscriptions/:param/actions": { action: "extend", days: 2, comment: "Late delivery" },
  "POST /api/v1/admin/rewards": { name: "₹50 off", points: 200, kind: "flat", value: 5000, validDays: 30 },
  "POST /api/v1/admin/rewards/adjust": { userId: "{{targetUserId}}", points: 100, reason: "Goodwill" },
  "POST /api/v1/admin/segments/preview": { rules: { op: "all", conditions: [{ field: "daysSinceLastOrder", operator: "gte", value: 14 }, { field: "isPlusMember", operator: "eq", value: false }] } },
  "POST /api/v1/admin/segments": { name: "Lapsed 14 days", rules: { op: "all", conditions: [{ field: "daysSinceLastOrder", operator: "gte", value: 14 }] } },
  "POST /api/v1/admin/segments/:param/import": { csv: "phone\n9000000031\n9000000032", mode: "replace" },
  "POST /api/v1/admin/campaigns": { name: "Weekend offer", segmentId: "{{segmentId}}", channels: ["push", "inapp"], variants: [{ key: "A", templateKey: "journey.win_back", weight: 50 }, { key: "B", templateKey: "journey.welcome", weight: 50 }], holdoutPercent: 5, schedule: { type: "once", sendAt: "2026-10-11T12:30:00.000Z" } },
  "POST /api/v1/admin/journeys": { key: "cart_nudge", name: "Cart nudge", trigger: { event: "cart.updated", filter: { minItems: 1 } }, steps: [{ type: "wait", minutes: 45 }, { type: "condition", check: "cart_not_empty" }, { type: "send", templateKey: "journey.cart_waiting", channels: ["push"] }], exitOn: ["order.placed"] },
  "POST /api/v1/admin/in-app-messages": { name: "Plus promo", screen: "home", type: "modal", title: "Try MealJi Plus", body: "Daily lunches, one price.", ctaLabel: "See plans", deepLink: "mealji://plus", status: "active" },
  "PUT /api/v1/admin/notification-templates/:param": { category: "marketing", inboxCategory: "offers", channels: { push: { title: "{{user.firstName}}, lunch is ready", body: "Order before 1 PM" }, inapp: { title: "Lunch is ready", body: "Order before 1 PM" } } },
  "POST /api/v1/admin/notifications/send": { userIds: ["{{targetUserId}}"], title: "Your order is delayed", body: "Sorry! It will reach you in 10 minutes.", channels: ["push", "inapp"] },
  "POST /api/v1/admin/experiments": { key: "cta_copy", name: "CTA copy", variants: [{ key: "control", weight: 50, config: { cta: "Order now" } }, { key: "bold", weight: 50, config: { cta: "Feed me" } }], allocationPercent: 100 },
  "POST /api/v1/admin/reports/:param/exports": { filters: { from: "2026-10-01", to: "2026-10-07" } },
  "POST /api/v1/admin/reports/schedules": { reportKey: "daily_sales", name: "Daily sales to founders", frequency: "daily", time: "08:00", rangeDays: 1, recipients: ["founders@example.com"] },
  "POST /api/v1/admin/delivery-providers/accounts": { provider: "porter", name: "Porter Bengaluru", cities: ["bengaluru"], credentials: {} },
  "POST /api/v1/admin/support/faqs": { category: "Orders", question: "How do I cancel?", answer: "Open the order and tap Cancel before the kitchen accepts it.", context: "default" },
  "POST /api/v1/admin/support/tickets/:param/messages": { body: "Sorry about that, we've added a credit.", internal: false },
  "PATCH /api/v1/admin/support/tickets/:param": { status: "resolved" },
  "PUT /api/v1/admin/search/synonyms": { term: "biryani", synonyms: ["biriyani", "briyani"] },
};

const VARIABLE_FOR = { id: "id", userId: "targetUserId", kitchenId: "kitchenId", slug: "roleSlug" };

function folderFor(apiPath) {
  const tail = apiPath.replace(/^\/api\/v1/, "");
  for (const [matcher, name] of FOLDERS) if (matcher.test(normalizePath(tail))) return name;
  return "Misc";
}

function nameFor(method, apiPath) {
  const tail = apiPath.replace(/^\/api\/v1/, "") || "/";
  return `${method} ${tail}`;
}

function urlFor(apiPath) {
  return `{{baseUrl}}${apiPath.replace(/:(\w+)/g, (match, name) => `{{${VARIABLE_FOR[name] || name}}}`).replace(/\/\*$/, "/{{key}}")}`;
}

const collection = JSON.parse(await readFile(collectionPath, "utf8"));
const have = new Set(collectPostman(collection.item));
const routes = await mountedRoutes();
let added = 0;
const usedVariables = new Set();

for (const [key, route] of routes) {
  if (have.has(key)) continue;
  // New app endpoints wait in one folder until they are given a release step.
  const natural = folderFor(route.path);
  const folderName = natural.startsWith("App") || natural === "Location" ? "App · not in a release step" : natural === "Auth" ? "Console sign-in" : natural;
  let folder = collection.item.find((item) => item.name === folderName && item.item);
  if (!folder) {
    folder = { name: folderName, item: [] };
    collection.item.push(folder);
  }
  const bodyKey = `${route.method} ${normalizePath(route.path)}`;
  const url = urlFor(route.path);
  for (const match of url.matchAll(/\{\{(\w+)\}\}/g)) usedVariables.add(match[1]);
  const request = {
    method: route.method,
    header: [{ key: "x-device-id", value: "{{deviceId}}" }],
    url,
    description: `${route.method} ${route.path}. See the API reference in the backend README for permissions and fields.`,
  };
  if (["POST", "PUT", "PATCH"].includes(route.method)) {
    request.header.push({ key: "Content-Type", value: "application/json" });
    request.body = { mode: "raw", raw: JSON.stringify(BODIES[bodyKey] || {}, null, 2), options: { raw: { language: "json" } } };
  }
  if (/^\/(api\/v1\/(webhooks|onboarding|app\/config)|u\/|r\/)/.test(route.path.replace(/^\//, "/"))) request.auth = { type: "noauth" };
  folder.item.push({ name: nameFor(route.method, route.path), request, response: [], id: crypto.randomUUID() });
  added += 1;
}

// Every {{variable}} used by the new requests exists on the collection.
const known = new Set((collection.variable || []).map((variable) => variable.key));
for (const name of usedVariables) {
  if (!known.has(name) && name !== "baseUrl") collection.variable.push({ key: name, value: "", type: "string" });
}
for (const name of ["dishId", "addressId", "orderId", "gatewayOrderId", "paymentId", "categoryId", "segmentId", "entityId", "masterDishId"]) {
  if (!collection.variable.some((variable) => variable.key === name)) collection.variable.push({ key: name, value: "", type: "string" });
}

// Keep folders in a stable, readable order: the app's release steps first
// (Step 01, Step 02 …), then the consoles and platform folders.
const order = ["Health", "Console sign-in", "App · not in a release step", "Kitchen desk", "Kitchen · Orders", "Kitchen · Menu", "Kitchen · Meal plan", "Kitchen · Reports", "Kitchens", "Admin"];
const rank = (name) => {
  const step = /^Step (\d+) · /.exec(name);
  if (step) return Number(step[1]) - 1000;
  const index = order.indexOf(name);
  return index < 0 ? 100 : index;
};
collection.item.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

await writeFile(collectionPath, `${JSON.stringify(collection, null, "\t")}\n`, "utf8");
console.log(`Added ${added} request(s) to the Postman collection.`);
process.exit(0);
