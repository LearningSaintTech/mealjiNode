// Demo data for every module (local and staging only). Each step is safe to
// re-run: records are found by a natural key (name, code, title) and only
// missing ones are created. Activity (orders, subscriptions, tickets) is
// created once; run `npm run seed -- --fresh` to wipe test data and rebuild it.
//
// Every demo account is flagged isDemo, so notifications triggered here (or
// later from the consoles) reach the in-app inbox only, never SMS/WhatsApp/
// email/push: the 90000000xx numbers may belong to real people.

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { logger } from "../src/config/logger.js";
import { addIstDays, istDateKey, istDateTime } from "../src/common/time.js";
import { roleRepository } from "../src/modules/role/role.repository.js";
import { User } from "../src/modules/user/user.model.js";
import { Kitchen } from "../src/modules/kitchen/kitchen.model.js";
import * as catalog from "../src/modules/catalog/catalog.service.js";
import { KitchenCategory, KitchenCombo, KitchenDish, MasterCategory, MasterDish } from "../src/modules/catalog/catalog.model.js";
import * as slots from "../src/modules/subscription/slot.service.js";
import * as plans from "../src/modules/subscription/plan.service.js";
import { MealSelection, SubscriptionPlan, Subscription } from "../src/modules/subscription/subscription.model.js";
import { saveSelection } from "../src/modules/subscription/mealplan.service.js";
import * as subscriptions from "../src/modules/subscription/subscription.service.js";
import * as content from "../src/modules/content/content.service.js";
import { Banner, OnboardingSlide } from "../src/modules/content/content.model.js";
import * as coupons from "../src/modules/coupon/coupon.service.js";
import { Coupon } from "../src/modules/coupon/coupon.model.js";
import * as billing from "../src/modules/billing/billing.service.js";
import { BillingEntity, Invoice } from "../src/modules/billing/billing.model.js";
import * as delivery from "../src/modules/delivery/delivery.service.js";
import { DeliveryProviderAccount } from "../src/modules/delivery/delivery.model.js";
import * as support from "../src/modules/support/support.service.js";
import { CannedReply, Faq, SupportTicket } from "../src/modules/support/support.model.js";
import * as rewards from "../src/modules/rewards/rewards.service.js";
import { Reward } from "../src/modules/rewards/rewards.model.js";
import * as segments from "../src/modules/engagement/segment.service.js";
import * as campaigns from "../src/modules/engagement/campaign.service.js";
import { Campaign } from "../src/modules/engagement/campaign.service.js";
import { ensureDefaultJourneys, Journey } from "../src/modules/engagement/journey.service.js";
import { computeTraits } from "../src/modules/engagement/traits.service.js";
import { Experiment, saveExperiment } from "../src/modules/experiment/experiment.service.js";
import * as addresses from "../src/modules/address/address.service.js";
import { Address } from "../src/modules/address/address.model.js";
import * as cart from "../src/modules/cart/cart.service.js";
import * as orders from "../src/modules/order/order.service.js";
import { Order } from "../src/modules/order/order.model.js";
import { invoiceOrder, onPaymentCaptured } from "../src/modules/payment/payment.service.js";
import { Payment, Refund } from "../src/modules/payment/payment.model.js";
import { rollupDay } from "../src/modules/analytics/analytics.service.js";

const DEMO_PHONE = /^90000000\d\d$/;

export const DEMO_STAFF = [
  { role: "ops_manager", name: "Arjun Menon", phone: "9000000003" },
  { role: "marketing_manager", name: "Sneha Kapoor", phone: "9000000004" },
  { role: "finance", name: "Vikram Iyer", phone: "9000000005" },
  { role: "support_agent", name: "Pooja Reddy", phone: "9000000006" },
  { role: "analyst", name: "Nikhil Jain", phone: "9000000007" },
];

// Customers near each kitchen (offsets in degrees from the kitchen pin, ~1 km).
const DEMO_CUSTOMERS = [
  { name: "Rahul Sharma", phone: "9000000031", kitchen: "Koramangala", at: [0.006, -0.004], house: "Flat 302, Lakeview Residency", street: "5th Cross, 6th Block", locality: "Koramangala", pincode: "560095", days: 58, orders: 12, plus: true },
  { name: "Priya Nair", phone: "9000000032", kitchen: "Koramangala", at: [-0.005, 0.006], house: "No. 14, 2nd Floor", street: "17th Main, 3rd Block", locality: "Koramangala", pincode: "560034", days: 52, orders: 9 },
  { name: "Aditya Verma", phone: "9000000033", kitchen: "Koramangala", at: [0.009, 0.003], house: "A-501, Prestige Acropolis", street: "Hosur Road", locality: "Adugodi", pincode: "560029", days: 41, orders: 7, plus: true },
  { name: "Kavya Menon", phone: "9000000034", kitchen: "Koramangala", at: [-0.008, -0.006], house: "House 22", street: "1st Cross, 8th Block", locality: "Koramangala", pincode: "560095", days: 33, orders: 5, lastOrderDaysAgo: 18 },
  { name: "Rohan Gupta", phone: "9000000035", kitchen: "Koramangala", at: [0.002, 0.011], house: "B-104, Salarpuria Serenity", street: "Sarjapur Road", locality: "HSR Layout", pincode: "560102", days: 26, orders: 4 },
  { name: "Ananya Singh", phone: "9000000036", kitchen: "Koramangala", at: [0.011, -0.009], house: "3rd Floor, WeWork Galaxy", street: "Residency Road", locality: "Koramangala", pincode: "560034", days: 40, orders: 2, label: "work", lastOrderDaysAgo: 22 },
  { name: "Siddharth Rao", phone: "9000000037", kitchen: "Indiranagar", at: [0.004, -0.005], house: "No. 7, Garden Villa", street: "12th Main, HAL 2nd Stage", locality: "Indiranagar", pincode: "560038", days: 45, orders: 8, plus: true },
  { name: "Neha Joshi", phone: "9000000038", kitchen: "Indiranagar", at: [-0.006, 0.004], house: "Flat 11, Silver Oaks", street: "CMH Road", locality: "Indiranagar", pincode: "560038", days: 29, orders: 5 },
  { name: "Karthik Subramanian", phone: "9000000039", kitchen: "Indiranagar", at: [0.007, 0.007], house: "C-202, Embassy Habitat", street: "Old Airport Road", locality: "Domlur", pincode: "560071", days: 12, orders: 2 },
  { name: "Divya Pillai", phone: "9000000040", kitchen: "Indiranagar", at: [-0.003, -0.008], house: "No. 31", street: "6th Cross, Defence Colony", locality: "Indiranagar", pincode: "560038", days: 4, orders: 0 },
];

// ------------------------------------------------------------------ menu

const MASTER_CATEGORIES = [
  { name: "Thalis & Meals", icon: "thali", subtitle: "Complete home-style meals", sortOrder: 0 },
  { name: "Curries", icon: "curry", subtitle: "Dals, sabzis and gravies", sortOrder: 1 },
  { name: "Rice & Biryani", icon: "rice", subtitle: "Pulao, biryani and rice bowls", sortOrder: 2 },
  { name: "Breads", icon: "roti", subtitle: "Fresh off the tawa", sortOrder: 3 },
  { name: "Breakfast", icon: "breakfast", subtitle: "Morning favourites", sortOrder: 4 },
  { name: "Sides & Salads", icon: "salad", subtitle: "Raita, salads and more", sortOrder: 5 },
  { name: "Desserts", icon: "dessert", subtitle: "Something sweet", sortOrder: 6 },
  { name: "Beverages", icon: "drink", subtitle: "Chai, buttermilk and coolers", sortOrder: 7 },
];

const SPICE = { name: "Spice level", minSelect: 1, maxSelect: 1, options: [{ name: "Mild" }, { name: "Medium" }, { name: "Hot" }] };
const EXTRAS = { name: "Add extra", minSelect: 0, maxSelect: 3, options: [{ name: "Extra roti", pricePaise: 1500 }, { name: "Extra rice", pricePaise: 2500 }, { name: "Papad", pricePaise: 1000 }] };

// [category, name, pricePaise, veg, extra fields]
const MASTER_DISHES = [
  ["Thalis & Meals", "Ghar Ka Veg Thali", 18900, true, { description: "Dal tadka, seasonal sabzi, jeera rice, 3 phulkas, salad and a sweet.", calories: 780, tags: ["thali", "bestseller"], cuisine: "North Indian", highlights: ["Changes daily", "No preservatives"], customizationGroups: [SPICE, EXTRAS], mealUpgrade: { label: "Make it a feast", description: "Add paneer sabzi and gulab jamun", pricePaise: 6000 }, preparationMinutes: 20 }],
  ["Thalis & Meals", "Rajma Chawal Bowl", 14900, true, { description: "Slow-cooked Kashmiri rajma over steamed basmati with pickled onions.", calories: 620, tags: ["bowl", "comfort"], cuisine: "North Indian", customizationGroups: [SPICE], preparationMinutes: 15 }],
  ["Thalis & Meals", "Chole Kulche Meal", 15900, true, { description: "Amritsari chole with two butter kulchas and onion salad.", calories: 710, tags: ["punjabi"], cuisine: "North Indian", customizationGroups: [SPICE], preparationMinutes: 15 }],
  ["Thalis & Meals", "Home-style Chicken Thali", 23900, false, { description: "Chicken curry, dal, rice, 3 phulkas, salad and raita.", calories: 890, tags: ["thali", "protein"], cuisine: "North Indian", spicyLevel: 2, customizationGroups: [SPICE, EXTRAS], mealUpgrade: { label: "Add a dessert", description: "Gulab jamun (2 pcs)", pricePaise: 4000 }, preparationMinutes: 25 }],
  ["Thalis & Meals", "South Indian Meals", 17900, true, { description: "Sambar, rasam, poriyal, kootu, curd rice, rice and appalam.", calories: 740, tags: ["thali", "south indian"], cuisine: "South Indian", preparationMinutes: 20 }],
  ["Curries", "Dal Tadka", 11900, true, { description: "Yellow dal tempered with ghee, cumin and garlic.", calories: 260, tags: ["dal", "protein"], cuisine: "North Indian", portions: [{ label: "Half", pricePaise: 7900 }, { label: "Full", pricePaise: 11900, isDefault: true }] }],
  ["Curries", "Paneer Butter Masala", 19900, true, { description: "Soft paneer in a velvety tomato and cashew gravy.", calories: 450, tags: ["paneer", "bestseller"], cuisine: "North Indian", spicyLevel: 1, portions: [{ label: "Half", pricePaise: 12900 }, { label: "Full", pricePaise: 19900, isDefault: true }] }],
  ["Curries", "Aloo Gobi", 12900, true, { description: "Dry-tossed potato and cauliflower with turmeric and ginger.", calories: 230, tags: ["sabzi"], cuisine: "North Indian" }],
  ["Curries", "Homestyle Chicken Curry", 21900, false, { description: "Bone-in chicken simmered the way it's made at home.", calories: 480, tags: ["chicken"], cuisine: "North Indian", spicyLevel: 2, customizationGroups: [SPICE] }],
  ["Curries", "Egg Curry", 15900, false, { description: "Two boiled eggs in an onion-tomato masala.", calories: 340, tags: ["egg", "protein"], cuisine: "North Indian", spicyLevel: 1 }],
  ["Rice & Biryani", "Veg Dum Biryani", 18900, true, { description: "Basmati layered with vegetables, saffron and fried onions. With raita.", calories: 640, tags: ["biryani"], cuisine: "Hyderabadi", spicyLevel: 1 }],
  ["Rice & Biryani", "Chicken Dum Biryani", 24900, false, { description: "Hyderabadi-style dum biryani with salan and raita.", calories: 820, tags: ["biryani", "bestseller"], cuisine: "Hyderabadi", spicyLevel: 2 }],
  ["Rice & Biryani", "Jeera Rice", 8900, true, { description: "Basmati tossed with cumin and ghee.", calories: 310, tags: ["rice"], cuisine: "North Indian" }],
  ["Rice & Biryani", "Curd Rice", 9900, true, { description: "Creamy curd rice with tempering and pomegranate.", calories: 290, tags: ["south indian", "light"], cuisine: "South Indian" }],
  ["Breads", "Phulka (2 pcs)", 3900, true, { description: "Whole-wheat phulkas, lightly ghee brushed.", calories: 160, tags: ["roti"], cuisine: "North Indian" }],
  ["Breads", "Butter Naan", 5900, true, { description: "Tandoor-style naan with butter.", calories: 260, tags: ["naan"], cuisine: "North Indian" }],
  ["Breads", "Aloo Paratha", 8900, true, { description: "Stuffed paratha with curd and pickle.", calories: 380, tags: ["paratha"], cuisine: "North Indian" }],
  ["Breakfast", "Poha", 6900, true, { description: "Flattened rice with peanuts, curry leaves and lemon.", calories: 270, tags: ["breakfast", "light"], cuisine: "Maharashtrian" }],
  ["Breakfast", "Idli Sambar (3 pcs)", 7900, true, { description: "Soft idlis with sambar and coconut chutney.", calories: 300, tags: ["breakfast", "south indian"], cuisine: "South Indian" }],
  ["Breakfast", "Masala Dosa", 9900, true, { description: "Crisp dosa with potato masala, sambar and chutneys.", calories: 420, tags: ["breakfast", "south indian", "bestseller"], cuisine: "South Indian" }],
  ["Breakfast", "Upma", 6900, true, { description: "Rava upma with vegetables and cashews.", calories: 280, tags: ["breakfast"], cuisine: "South Indian" }],
  ["Sides & Salads", "Boondi Raita", 4900, true, { description: "Chilled curd with boondi and roasted cumin.", calories: 120, tags: ["side"], cuisine: "North Indian" }],
  ["Sides & Salads", "Kachumber Salad", 4900, true, { description: "Cucumber, tomato and onion with lemon.", calories: 60, tags: ["side", "healthy"], cuisine: "North Indian" }],
  ["Desserts", "Gulab Jamun (2 pcs)", 5900, true, { description: "Warm khoya dumplings in cardamom syrup.", calories: 300, tags: ["dessert"], cuisine: "North Indian" }],
  ["Desserts", "Rice Kheer", 6900, true, { description: "Slow-cooked rice pudding with saffron and nuts.", calories: 280, tags: ["dessert"], cuisine: "North Indian" }],
  ["Beverages", "Masala Chai", 3900, true, { description: "Ginger-cardamom chai.", calories: 90, tags: ["drink", "hot"], cuisine: "Indian" }],
  ["Beverages", "Masala Chaas", 4900, true, { description: "Spiced buttermilk with mint.", calories: 70, tags: ["drink", "cold"], cuisine: "Indian" }],
  ["Beverages", "Filter Coffee", 4900, true, { description: "South Indian decoction coffee.", calories: 110, tags: ["drink", "hot"], cuisine: "South Indian" }],
];

const BREAKFAST = ["Poha", "Idli Sambar (3 pcs)", "Masala Dosa", "Upma", "Aloo Paratha", "Masala Chai", "Filter Coffee"];
const BESTSELLERS = ["Ghar Ka Veg Thali", "Paneer Butter Masala", "Chicken Dum Biryani", "Masala Dosa"];

const KITCHEN_SETUP = {
  Koramangala: {
    skip: [],
    combos: [
      { title: "Lunch for two", subtitle: "2 veg thalis + 2 gulab jamun", items: [["Ghar Ka Veg Thali", 2], ["Gulab Jamun (2 pcs)", 1]], pricePaise: 39900, isSignature: true, serves: 2, badge: "Save ₹38" },
      { title: "Paneer meal box", subtitle: "Paneer butter masala, jeera rice, 2 phulkas", items: [["Paneer Butter Masala", 1], ["Jeera Rice", 1], ["Phulka (2 pcs)", 1]], pricePaise: 27900, isSignature: true },
      { title: "Biryani feast", subtitle: "Chicken biryani, raita and kheer", items: [["Chicken Dum Biryani", 1], ["Boondi Raita", 1], ["Rice Kheer", 1]], pricePaise: 32900 },
    ],
    about: { chefName: "Anita Rao", title: "Cooking like it's for family since 2009", story: "Anita started cooking lunch boxes for her neighbours in Koramangala. Every thali still follows her mother's recipes: fresh masalas ground each morning, cold-pressed oils and no preservatives." },
    hours: { opensAt: "08:00", closesAt: "21:00" },
  },
  Indiranagar: {
    skip: ["Home-style Chicken Thali", "Egg Curry"],
    combos: [
      { title: "South Indian breakfast", subtitle: "Masala dosa, 2 idlis and filter coffee", items: [["Masala Dosa", 1], ["Idli Sambar (3 pcs)", 1], ["Filter Coffee", 1]], pricePaise: 19900, isSignature: true },
      { title: "Thali + chaas", subtitle: "South Indian meals with masala chaas", items: [["South Indian Meals", 1], ["Masala Chaas", 1]], pricePaise: 20900 },
    ],
    about: { chefName: "Meera Shah", title: "Breakfasts and meals from a Gujarati-Tamil kitchen", story: "Meera's kitchen mixes the two homes she grew up between: soft idlis, crisp dosas and a comforting daily meal. Everything is made in small batches through the day." },
    hours: { opensAt: "07:00", closesAt: "22:00" },
  },
};

// ------------------------------------------------------------------ helpers

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const minutes = (n) => n * 60_000;
const kitchenKey = (kitchen) => (kitchen.name.includes("Indiranagar") ? "Indiranagar" : "Koramangala");

async function demoKitchens() {
  const rows = await Kitchen.find({ phoneNumber: { $in: ["9000000011", "9000000021"] } });
  return Object.fromEntries(rows.map((kitchen) => [kitchenKey(kitchen), kitchen]));
}

// ------------------------------------------------------------------ fresh

// Collections cleared by --fresh. Settings, roles, permissions, audit history,
// kitchens and accounts are kept.
const WIPE = [
  "orders", "payments", "refunds", "invoices", "deliveryjobs", "carts", "couponredemptions", "coupons",
  "subscriptions", "mealselections", "subscriptionplans", "slotmenus", "mealslots",
  "kitchendishes", "kitchencategories", "kitchencombos", "menuchangerequests", "masterdishes", "mastercategories",
  "banners", "onboardingslides", "supporttickets", "ticketmessages", "faqs", "cannedreplies",
  "notifications", "messagelogs", "analyticsevents", "metricsdailies", "campaigns", "campaignrecipients",
  "inappmessages", "inappimpressions", "experiments", "journeyenrollments", "segments", "userstats",
  "rewards", "rewardtransactions", "rewardredemptions", "referrals", "favorites", "searchlogs", "demandlogs",
  "reportjobs", "savedpaymentmethods", "outboxevents", "processedevents", "counters", "billingentities", "webhookevents",
];

export async function wipeTestData() {
  const db = mongoose.connection.db;
  const dir = path.resolve(".seed-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set((await db.listCollections().toArray()).map((item) => item.name));
  for (const name of WIPE) {
    if (!existing.has(name)) continue;
    const rows = await db.collection(name).find().toArray();
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rows));
    await db.collection(name).deleteMany({});
  }
  // Journeys: drop test journeys; the built-in ones are recreated (switched off).
  await Journey.deleteMany({ key: { $regex: /^e2e_/ } });
  // Test-only accounts made by the end-to-end runs.
  await User.deleteMany({ name: { $regex: /^(friend test|e2e)/i } });
  const demoIds = (await User.find({ phoneNumber: DEMO_PHONE }).select("_id").lean()).map((user) => user._id);
  await Address.deleteMany({ user: { $in: demoIds } });
  await User.updateMany({ _id: { $in: demoIds } }, { $set: { pointsBalance: 0, lifetimePoints: 0, tier: null, referredBy: null, subscription: {}, birthdayRewardYear: null } });
  for (const kitchen of await Kitchen.find()) await catalog.invalidateMenu(kitchen._id, "seed").catch(() => {});
  await content.invalidateContent().catch(() => {});
  logger.info({ backup: dir }, "Test data cleared (backup written)");
}

// ------------------------------------------------------------------ accounts

async function seedAccounts() {
  for (const account of [...DEMO_STAFF, ...DEMO_CUSTOMERS.map((item) => ({ ...item, role: "user" }))]) {
    if (await User.exists({ countryCode: "+91", phoneNumber: account.phone })) continue;
    const role = await roleRepository.findBySlug(account.role);
    const createdAt = account.days ? new Date(Date.now() - account.days * 86_400_000) : new Date();
    const user = await User.create({ name: account.name, countryCode: "+91", phoneNumber: account.phone, role: role._id, isActive: true, isNumberVerified: true, isDemo: true });
    if (account.days) await User.collection.updateOne({ _id: user._id }, { $set: { createdAt } });
  }
  // Older demo accounts (Phase 0 seed) get the flag too.
  await User.updateMany({ phoneNumber: DEMO_PHONE }, { $set: { isDemo: true } });
  for (const account of DEMO_CUSTOMERS) {
    if (account.days) await User.collection.updateOne({ phoneNumber: account.phone, createdAt: { $gt: new Date(Date.now() - account.days * 86_400_000 + 86_400_000) } }, { $set: { createdAt: new Date(Date.now() - account.days * 86_400_000) } });
  }
}

// ------------------------------------------------------------------ catalog

async function seedCatalog(kitchens) {
  const masterCategories = {};
  for (const category of MASTER_CATEGORIES) {
    const found = await MasterCategory.findOne({ name: category.name }).lean();
    masterCategories[category.name] = found ? String(found._id) : (await catalog.saveMasterCategory(null, category)).categoryId;
  }
  const masterIds = {};
  for (const [categoryName, name, pricePaise, isVeg, extra] of MASTER_DISHES) {
    const found = await MasterDish.findOne({ name }).lean();
    masterIds[name] = found ? String(found._id) : (await catalog.saveMasterDish(null, { name, isVeg, suggestedPricePaise: pricePaise, categoryId: masterCategories[categoryName], servesCount: 1, ...extra })).masterDishId;
  }

  for (const [key, kitchen] of Object.entries(kitchens)) {
    const setup = KITCHEN_SETUP[key];
    const kitchenId = kitchen._id;
    for (const category of MASTER_CATEGORIES) {
      let row = await KitchenCategory.findOne({ kitchen: kitchenId, name: category.name }).lean();
      if (!row) row = { _id: (await catalog.createCategory(kitchenId, category)).categoryId };
      const wanted = MASTER_DISHES.filter(([categoryName, name]) => categoryName === category.name && !setup.skip.includes(name)).map(([, name]) => masterIds[name]);
      if (wanted.length) {
        const missing = [];
        for (const id of wanted) if (!(await KitchenDish.exists({ kitchen: kitchenId, masterDish: id }))) missing.push(id);
        if (missing.length) await catalog.importMasterDishes(kitchenId, { masterDishIds: missing, categoryId: String(row._id) }, { platform: true });
      }
    }
    // Slots, bestsellers and stock for imported dishes.
    const dishes = await KitchenDish.find({ kitchen: kitchenId }).lean();
    const byName = new Map(dishes.map((dish) => [dish.name, dish]));
    for (const dish of dishes) {
      const isBreakfast = BREAKFAST.includes(dish.name);
      const update = {
        availableSlots: isBreakfast ? ["breakfast", "snacks"] : ["lunch", "dinner"],
        isBestseller: BESTSELLERS.includes(dish.name),
        originalPricePaise: BESTSELLERS.includes(dish.name) ? Math.round(dish.pricePaise * 1.15 / 100) * 100 : null,
      };
      if (key === "Indiranagar" && isBreakfast) update.availableSlots = ["breakfast", "lunch", "snacks"];
      await KitchenDish.updateOne({ _id: dish._id }, { $set: update });
    }
    for (const combo of setup.combos) {
      if (await KitchenCombo.exists({ kitchen: kitchenId, title: combo.title })) continue;
      await catalog.createCombo(kitchenId, { ...combo, items: combo.items.map(([name, qty]) => ({ dishId: String(byName.get(name)._id), qty })) }, { platform: true });
    }
    await catalog.invalidateMenu(kitchenId, "seed");
  }
}

// ------------------------------------------------------------------ kitchens

const SLOT_TIMES = {
  breakfast: { windowStart: "07:30", windowEnd: "09:30", cutoffDay: "previous_day", cutoffTime: "21:00", prepStart: "06:30", dispatchTime: "07:15", capacity: 80 },
  lunch: { windowStart: "12:30", windowEnd: "14:30", cutoffDay: "same_day", cutoffTime: "10:00", prepStart: "10:30", dispatchTime: "12:00", capacity: 150 },
  dinner: { windowStart: "19:30", windowEnd: "21:30", cutoffDay: "same_day", cutoffTime: "17:00", prepStart: "17:30", dispatchTime: "19:00", capacity: 120, activeDays: [1, 2, 3, 4, 5, 6] },
};

// Weekly rotation for subscription menus (index = weekday, 0 = Sunday).
const LUNCH_ROTATION = [
  ["Rajma Chawal Bowl", "Chole Kulche Meal", "Veg Dum Biryani"],
  ["Ghar Ka Veg Thali", "Dal Tadka", "Jeera Rice", "Aloo Gobi"],
  ["Rajma Chawal Bowl", "Paneer Butter Masala", "Phulka (2 pcs)"],
  ["South Indian Meals", "Curd Rice", "Dal Tadka"],
  ["Ghar Ka Veg Thali", "Veg Dum Biryani", "Boondi Raita"],
  ["Chole Kulche Meal", "Paneer Butter Masala", "Jeera Rice"],
  ["Ghar Ka Veg Thali", "Rajma Chawal Bowl", "Rice Kheer"],
];

async function seedKitchenOps(kitchens) {
  for (const [key, kitchen] of Object.entries(kitchens)) {
    const setup = KITCHEN_SETUP[key];
    const update = {};
    if (!kitchen.about?.chefName) update.about = { ...setup.about, gallery: [] };
    if (kitchen.status !== "active") Object.assign(update, { status: "active", acceptingOrders: true });
    if (Object.keys(update).length) await Kitchen.updateOne({ _id: kitchen._id }, { $set: update });

    for (const [slot, times] of Object.entries(SLOT_TIMES)) await slots.saveSlot(kitchen._id, slot, times);
    const dishes = new Map((await KitchenDish.find({ kitchen: kitchen._id, isActive: true }).lean()).map((dish) => [dish.name, String(dish._id)]));
    const ids = (names) => names.map((name) => dishes.get(name)).filter(Boolean);
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const lunch = ids(LUNCH_ROTATION[weekday]);
      if (lunch.length) await slots.saveSlotMenu(kitchen._id, { slot: "lunch", weekday, dishIds: lunch, defaultDishIds: lunch.slice(0, 1), note: null });
      const dinner = ids(LUNCH_ROTATION[(weekday + 3) % 7]);
      if (dinner.length) await slots.saveSlotMenu(kitchen._id, { slot: "dinner", weekday, dishIds: dinner, defaultDishIds: dinner.slice(0, 1) });
      const breakfast = ids([BREAKFAST[weekday % 4], BREAKFAST[(weekday + 1) % 4], "Masala Chai"]);
      if (breakfast.length) await slots.saveSlotMenu(kitchen._id, { slot: "breakfast", weekday, dishIds: breakfast, defaultDishIds: breakfast.slice(0, 1) });
    }
  }
}

// ------------------------------------------------------------------ plans

const PLANS = [
  { code: "LUNCH_WEEKLY", name: "Lunch Weekly", subtitle: "6 home-style lunches", badge: null, pricePaise: 99900, mrpPaise: 119400, cycleDays: 7, cycleLabel: "Weekly", slots: ["lunch"], activeDays: [1, 2, 3, 4, 5, 6], mealsPerDay: 1, minItemsPerMeal: 1, maxItemsPerMeal: 2, billingMethods: ["autopay", "link"], noSelectionPolicy: "auto_shift", autoShiftFallback: "chef_default", maxShiftsPerCycle: 2, maxAutoShiftsPerCycle: 2, deliveryIncluded: true, benefits: ["Free delivery on every meal", "Pick your meal by 10 AM", "Pause anytime"], sortOrder: 1 },
  { code: "LUNCH_MONTHLY", name: "Lunch Monthly", subtitle: "26 lunches, best value", badge: "Most popular", pricePaise: 349900, mrpPaise: 399900, cycleDays: 30, cycleLabel: "Monthly", slots: ["lunch"], activeDays: [1, 2, 3, 4, 5, 6], mealsPerDay: 1, minItemsPerMeal: 1, maxItemsPerMeal: 2, billingMethods: ["autopay", "link"], noSelectionPolicy: "auto_shift", autoShiftFallback: "chef_default", maxShiftsPerCycle: 4, maxAutoShiftsPerCycle: 4, deliveryIncluded: true, isPopular: true, benefits: ["Free delivery on every meal", "10% off on regular orders", "Pause up to 3 months"], perks: { freeDeliveryOnOrders: true, orderDiscountPercent: 10 }, sortOrder: 2 },
  { code: "LUNCH_DINNER_MONTHLY", name: "Lunch + Dinner Monthly", subtitle: "Two meals a day, sorted", badge: "Family favourite", pricePaise: 649900, mrpPaise: 759900, cycleDays: 30, cycleLabel: "Monthly", slots: ["lunch", "dinner"], activeDays: [1, 2, 3, 4, 5, 6], mealsPerDay: 2, minItemsPerMeal: 1, maxItemsPerMeal: 2, billingMethods: ["autopay"], noSelectionPolicy: "auto_shift", autoShiftFallback: "chef_default", maxShiftsPerCycle: 6, maxAutoShiftsPerCycle: 6, deliveryIncluded: true, benefits: ["Lunch and dinner every weekday", "Free delivery", "15% off on regular orders"], perks: { freeDeliveryOnOrders: true, orderDiscountPercent: 15 }, sortOrder: 3 },
  { code: "BREAKFAST_MONTHLY", name: "Breakfast Monthly", subtitle: "Start every day right", pricePaise: 199900, mrpPaise: 239900, cycleDays: 30, cycleLabel: "Monthly", slots: ["breakfast"], activeDays: [1, 2, 3, 4, 5, 6], mealsPerDay: 1, billingMethods: ["autopay", "link"], noSelectionPolicy: "auto_shift", autoShiftFallback: "skip", deliveryIncluded: true, benefits: ["Breakfast by 9:30 AM"], sortOrder: 4, draft: true },
];

async function seedPlans() {
  for (const { draft, ...plan } of PLANS) {
    let row = await SubscriptionPlan.findOne({ code: plan.code }).lean();
    if (!row) {
      const created = await plans.savePlan(null, { ...plan, cities: ["Bengaluru"] });
      row = { _id: created.planId, status: "draft" };
    }
    if (!draft && row.status === "draft") await plans.setPlanStatus(String(row._id), "active");
  }
}

// ------------------------------------------------------------------ content & offers

async function seedContent(kitchens) {
  const banners = [
    { placement: "home_hero", eyebrow: "New here?", title: "Flat ₹50 off your first meal", highlight: "₹50 off", subtitle: "Use code WELCOME50 on orders above ₹199", ctaLabel: "Order now", deepLink: "mealji://menu", couponCode: "WELCOME50", sortOrder: 0 },
    { placement: "home_hero", eyebrow: "MealJi Plus", title: "Lunch sorted for the month", highlight: "from ₹134/meal", subtitle: "26 home-style lunches with free delivery", ctaLabel: "See plans", deepLink: "mealji://plus", sortOrder: 1 },
    { placement: "home_promo", title: "Weekend thali specials", subtitle: "Feast thalis every Saturday and Sunday", ctaLabel: "Explore", deepLink: "mealji://menu?tag=thali", sortOrder: 0 },
    { placement: "home_how_we_cook", title: "Cooked fresh, every single day", subtitle: "Masalas ground each morning, cold-pressed oils, no preservatives", sortOrder: 0 },
    { placement: "menu_hero", title: "Today's bestsellers", subtitle: "What Bengaluru is ordering right now", deepLink: "mealji://menu?sort=popular", sortOrder: 0 },
    { placement: "offers", title: "20% off on orders above ₹299", subtitle: "Code MEALJI20, up to ₹100 off", couponCode: "MEALJI20", sortOrder: 0 },
  ];
  for (const banner of banners) {
    if (!(await Banner.exists({ title: banner.title }))) await content.saveBanner(null, { ...banner, cities: ["Bengaluru"], isActive: true });
  }
  const slides = [
    { title: "Home-style food, delivered", subtitle: "Real kitchens, real home cooks, cooking the food you grew up on.", sortOrder: 0 },
    { title: "Fresh every day", subtitle: "Menus change daily. Nothing is frozen, nothing is reheated.", sortOrder: 1 },
    { title: "Lunch on autopilot", subtitle: "Subscribe to MealJi Plus and never think about lunch again.", sortOrder: 2 },
  ];
  for (const slide of slides) if (!(await OnboardingSlide.exists({ title: slide.title }))) await content.saveSlide(null, { ...slide, isActive: true });

  const now = Date.now();
  const offers = [
    { code: "WELCOME50", title: "₹50 off your first order", description: "For your first MealJi order", type: "flat", value: 5000, minOrderPaise: 19900, firstOrderOnly: true, perUserLimit: 1, terms: ["Valid on your first order only", "Minimum order ₹199"] },
    { code: "MEALJI20", title: "20% off up to ₹100", description: "On orders above ₹299", type: "percent", value: 20, maxDiscountPaise: 10000, minOrderPaise: 29900, perUserLimit: 3, terms: ["Up to 3 times per customer"] },
    { code: "FREEDEL", title: "Free delivery", description: "On orders above ₹249", type: "free_delivery", value: 0, minOrderPaise: 24900, perUserLimit: 5 },
    { code: "UPI25", title: "₹25 off with UPI", description: "Pay with any UPI app", type: "flat", value: 2500, minOrderPaise: 14900, paymentMethods: ["upi"], perUserLimit: 2 },
    { code: "DIWALI100", title: "₹100 off this Diwali", description: "Festive offer on orders above ₹499", type: "flat", value: 10000, minOrderPaise: 49900, validFrom: new Date(now + 10 * 86_400_000), validTo: new Date(now + 20 * 86_400_000), perUserLimit: 1 },
    { code: "MONSOON15", title: "15% off (ended)", type: "percent", value: 15, maxDiscountPaise: 7500, validFrom: new Date(now - 60 * 86_400_000), validTo: new Date(now - 30 * 86_400_000), isActive: false },
  ];
  for (const offer of offers) if (!(await Coupon.exists({ code: offer.code }))) await coupons.saveCoupon(null, { isPublic: true, isActive: true, ...offer });

  // Invoicing entity (GST) and delivery partner accounts.
  let entity = await BillingEntity.findOne({ invoicePrefix: "MJ" }).lean();
  if (!entity) {
    const created = await billing.createEntity({ legalName: "MealJi Foods Private Limited", tradeName: "MealJi", gstin: "29AAQCM4821K1Z7", fssai: "11225999000123", pan: "AAQCM4821K", addressLine: "3rd Floor, 80 Feet Road, 4th Block, Koramangala", city: "Bengaluru", state: "Karnataka", stateCode: "29", pincode: "560034", email: "billing@mealji.example", phone: "08040001234", invoicePrefix: "MJ", signatory: "Authorised signatory", isDefault: true, isActive: true });
    entity = { _id: created.entityId };
  }
  for (const kitchen of Object.values(kitchens)) if (!kitchen.billingEntity) await billing.mapKitchen(String(kitchen._id), String(entity._id));
  if (!(await DeliveryProviderAccount.exists({ name: "MealJi riders (manual dispatch)" }))) {
    await delivery.saveProviderAccount(null, { provider: "manual", name: "MealJi riders (manual dispatch)", cities: ["bengaluru"], credentials: {}, isActive: true });
  }
}

// ------------------------------------------------------------------ support & loyalty

async function seedSupportAndRewards(kitchens) {
  for (const [index, category] of (await support.listCategories({ all: true })).entries()) {
    await support.saveCategory(category.key, { name: category.name, icon: category.icon, issueTypes: category.issueTypes, context: category.context || "both", slaHours: category.key === "order" ? 2 : category.key === "payment" ? 12 : 24, sortOrder: index, isActive: true });
  }
  const faqs = [
    ["order", "Where is my order?", "Open Orders and tap your order to track it live. You'll also get updates when it's accepted, picked up and delivered."],
    ["order", "Can I cancel my order?", "You can cancel before the kitchen accepts it. After that, contact us from the order screen and we'll help."],
    ["payment", "When will I get my refund?", "Refunds reach UPI within 1-3 working days and cards within 5-7 working days."],
    ["payment", "Is cash on delivery available?", "Yes, for orders up to the limit shown at checkout."],
    ["account", "How do I change my phone number?", "Go to Profile, then Phone number, and verify the new number with an OTP."],
    ["subscription", "How do I pause MealJi Plus?", "Open MealJi Plus, tap Manage, then Pause. You can pause for 1 to 3 months.", "subscription"],
    ["subscription", "What if I forget to pick my meal?", "If you don't choose by the cutoff, we send the chef's pick for the day, so you never miss a meal.", "subscription"],
  ];
  for (const [index, [category, question, answer, context]] of faqs.entries()) {
    if (!(await Faq.exists({ question }))) await support.saveFaq(null, { category, question, answer, context: context || "default", sortOrder: index, isActive: true });
  }
  const canned = [
    ["Apology – late delivery", "We're sorry your order arrived late. We've shared this with the kitchen and our delivery team so it doesn't happen again.", "order"],
    ["Refund initiated", "We've started your refund. It reaches UPI within 1-3 working days and cards within 5-7 working days.", "payment"],
    ["Missing item – refund", "Sorry about the missing item. We've refunded it to your original payment method.", "order"],
    ["Pause instructions", "You can pause MealJi Plus from the app: MealJi Plus → Manage → Pause. Choose 1 to 3 months.", "subscription"],
    ["Closing – resolved", "Glad we could sort this out! We're closing this ticket; reply anytime if you need more help.", null],
  ];
  for (const [title, body, category] of canned) if (!(await CannedReply.exists({ title }))) await support.saveCanned(null, { title, body, category });

  const jamun = await KitchenDish.findOne({ kitchen: kitchens.Koramangala?._id, name: "Gulab Jamun (2 pcs)" }).lean();
  const catalogRewards = [
    { name: "₹50 off your next order", description: "Minimum order ₹199", points: 500, kind: "flat", value: 5000, minOrderPaise: 19900, validDays: 30, sortOrder: 0 },
    { name: "Free delivery", description: "On any one order", points: 300, kind: "free_delivery", value: 0, validDays: 30, sortOrder: 1 },
    { name: "15% off up to ₹120", points: 800, kind: "percent", value: 15, maxDiscountPaise: 12000, minOrderPaise: 29900, validDays: 30, sortOrder: 2 },
    jamun ? { name: "Free Gulab Jamun", description: "Added to your next Koramangala order", points: 400, kind: "dish", value: 0, dishId: String(jamun._id), validDays: 15, sortOrder: 3 } : null,
    { name: "₹150 off (Gold Kadai & above)", points: 1200, kind: "flat", value: 15000, minOrderPaise: 49900, validDays: 30, tiers: ["Gold Kadai", "Black Makhani"], sortOrder: 4 },
  ].filter(Boolean);
  for (const reward of catalogRewards) if (!(await Reward.exists({ name: reward.name }))) await rewards.saveReward(null, { ...reward, isActive: true });
}

// ------------------------------------------------------------------ engagement

const SEGMENTS = [
  { name: "New sign-ups, no order yet", description: "Signed up but never ordered", rules: { op: "all", conditions: [{ field: "ordersCount", operator: "eq", value: 0 }] } },
  { name: "Repeat customers", description: "3 or more delivered orders", rules: { op: "all", conditions: [{ field: "deliveredOrdersCount", operator: "gte", value: 3 }] } },
  { name: "Lapsed 14+ days", description: "Ordered before, nothing in the last 14 days", rules: { op: "all", conditions: [{ field: "ordersCount", operator: "gte", value: 1 }, { field: "daysSinceLastOrder", operator: "gte", value: 14 }] } },
  { name: "High value (₹1,500+)", description: "Lifetime spend of ₹1,500 or more", rules: { op: "all", conditions: [{ field: "lifetimeValuePaise", operator: "gte", value: 150000 }] } },
  { name: "MealJi Plus members", description: "Active subscribers", rules: { op: "all", conditions: [{ field: "isPlusMember", operator: "eq", value: true }] } },
  { name: "Veg lovers", description: "80% or more of items ordered are veg", rules: { op: "all", conditions: [{ field: "vegShare", operator: "gte", value: 0.8 }, { field: "ordersCount", operator: "gte", value: 2 }] } },
  { name: "Plus prospects", description: "Regular customers who don't have Plus yet", rules: { op: "all", conditions: [{ field: "deliveredOrdersCount", operator: "gte", value: 4 }, { field: "isPlusMember", operator: "eq", value: false }] } },
];

async function seedEngagement(actor) {
  await ensureDefaultJourneys();
  const ids = {};
  for (const segment of SEGMENTS) {
    const found = await segments.Segment.findOne({ name: segment.name }).lean();
    ids[segment.name] = found ? String(found._id) : (await segments.saveSegment(null, segment, actor)).segmentId;
  }
  if (!(await Campaign.exists({ name: "Weekend thali offer" }))) {
    await campaigns.saveCampaign(null, { name: "Weekend thali offer", objective: "Bring lapsed customers back with the weekend thali", channels: ["inapp", "push"], audience: "segment", segmentId: ids["Lapsed 14+ days"], variants: [{ key: "A", templateKey: "campaign.generic", weight: 1 }], holdoutPercent: 10, data: { title: "Your weekend thali is waiting", body: "Get 20% off with MEALJI20 this weekend." }, couponCode: "MEALJI20", deepLink: "mealji://menu?tag=thali" }, actor);
  }
  if (!(await Campaign.exists({ name: "Try MealJi Plus" }))) {
    await campaigns.saveCampaign(null, { name: "Try MealJi Plus", objective: "Convert regulars to Plus", channels: ["inapp"], audience: "segment", segmentId: ids["Plus prospects"], variants: [{ key: "A", templateKey: "campaign.generic", weight: 1 }, { key: "B", templateKey: "journey.plus_upsell", weight: 1 }], holdoutPercent: 0, data: { title: "Lunch, sorted for the month", body: "26 lunches with free delivery from ₹134 a meal." }, deepLink: "mealji://plus" }, actor);
  }
  if (!(await Experiment.exists({ key: "home_hero_copy" }))) {
    await saveExperiment(null, { key: "home_hero_copy", name: "Home hero copy", description: "Does a price-led headline beat a benefit-led one?", variants: [{ key: "control", weight: 50, config: { headline: "Home-style food, delivered" } }, { key: "price", weight: 50, config: { headline: "Home-style meals from ₹149" } }], allocationPercent: 100, metric: "order_placed", windowDays: 14 });
  }
}

// ------------------------------------------------------------------ activity

async function seedAddresses(kitchens) {
  const out = {};
  for (const customer of DEMO_CUSTOMERS) {
    const user = await User.findOne({ phoneNumber: customer.phone }).lean();
    const kitchen = kitchens[customer.kitchen];
    let address = await Address.findOne({ user: user._id, deletedAt: null }).lean();
    if (!address) {
      const created = await addresses.createAddress(user._id, {
        label: customer.label || "home",
        recipientName: customer.name,
        phone: customer.phone,
        houseFlat: customer.house,
        street: customer.street,
        locality: customer.locality,
        city: "Bengaluru",
        state: "Karnataka",
        pincode: customer.pincode,
        latitude: Number((kitchen.latitude + customer.at[0]).toFixed(6)),
        longitude: Number((kitchen.longitude + customer.at[1]).toFixed(6)),
        isDefault: true,
      });
      address = { _id: created.addressId };
    }
    out[customer.phone] = { user, addressId: String(address._id), kitchen };
  }
  return out;
}

// Shifts every timestamp of an order (and its payment/invoice) to `placedAt`,
// with realistic gaps between the steps.
async function backdateOrder(orderId, placedAt, random) {
  const order = await Order.findById(orderId).lean();
  const gaps = { placed: 0, accepted: 2 + Math.floor(random() * 4), preparing: 1, ready: 18 + Math.floor(random() * 12), dispatched: 2 + Math.floor(random() * 4), delivered: 16 + Math.floor(random() * 18), cancelled: 4 };
  let at = placedAt.getTime();
  const times = {};
  const history = order.statusHistory.map((entry) => {
    at += minutes(gaps[entry.status] ?? 0);
    times[entry.status] = new Date(at);
    return { ...entry, at: new Date(at) };
  });
  const set = { createdAt: placedAt, updatedAt: new Date(at), statusHistory: history, placedAt: times.placed || placedAt, estimatedDeliveryAt: new Date(placedAt.getTime() + minutes(order.etaMinutes || 40)) };
  for (const [status, field] of Object.entries({ accepted: "acceptedAt", ready: "readyAt", dispatched: "dispatchedAt", delivered: "deliveredAt", cancelled: "cancelledAt" })) if (times[status]) set[field] = times[status];
  if (order.rating?.at) set["rating.at"] = new Date(at + minutes(30 + Math.floor(random() * 240)));
  await Order.collection.updateOne({ _id: order._id }, { $set: set });
  await Payment.collection.updateMany({ refType: "order", refId: order._id }, { $set: { createdAt: placedAt, capturedAt: placedAt, updatedAt: placedAt } });
  await Invoice.collection.updateMany({ refType: "order", refId: order._id }, { $set: { createdAt: placedAt, updatedAt: placedAt, issuedAt: placedAt } });
  await Refund.collection.updateMany({ order: order._id }, { $set: { createdAt: new Date(at), updatedAt: new Date(at) } });
}

const RATING_COMMENTS = ["Tasted just like home!", "Hot and fresh, loved the dal.", "Portion could be bigger.", "Perfect lunch, will order again.", "A little too spicy for me.", null, null];

async function placeDemoOrder({ user, addressId, kitchen }, plan, random) {
  const dishes = await KitchenDish.find({ kitchen: kitchen._id, isActive: true, approvalStatus: "live", availableSlots: plan.slot }).lean();
  const combos = await KitchenCombo.find({ kitchen: kitchen._id, isActive: true, approvalStatus: "live" }).lean();
  await cart.clearCart(user._id);
  if (combos.length && random() < 0.2) {
    await cart.addItem(user._id, { comboId: String(combos[Math.floor(random() * combos.length)]._id), qty: 1 });
  } else {
    const count = 1 + Math.floor(random() * 3);
    for (let index = 0; index < count; index += 1) {
      const dish = dishes[Math.floor(random() * dishes.length)];
      const group = (dish.customizationGroups || []).find((item) => item.minSelect > 0);
      await cart.addItem(user._id, { dishId: String(dish._id), qty: random() < 0.2 ? 2 : 1, optionIds: group ? [group.options[Math.floor(random() * group.options.length)].optionId] : [] });
    }
  }
  if (plan.coupon) await cart.applyPromo(user._id, plan.coupon).catch(() => cart.removePromo(user._id));
  const result = await orders.placeOrder(user._id, { addressId, paymentMethod: plan.payment, tipPaise: random() < 0.25 ? 2000 : 0, deliveryMode: "delivery", platform: random() < 0.7 ? "android" : "ios" });
  if (result.payment) {
    const payment = await Payment.findById(result.payment.paymentId);
    await onPaymentCaptured(payment, { gatewayPaymentId: `pay_demo_${payment._id}`, method: plan.payment });
  }
  return result.order.orderId;
}

async function advance(orderId, target, random) {
  const kitchenStep = async (to) => {
    const order = await Order.findById(orderId).lean();
    if (order.status === to) return;
    await orders.transition(orderId, to, { actor: "kitchen", by: { role: "kitchen_admin", name: "Kitchen" } });
  };
  if (target === "cancelled_kitchen") {
    await orders.transition(orderId, "cancelled", { actor: "kitchen", reason: random() < 0.5 ? "Item ran out" : "Kitchen too busy", cancelledBy: "kitchen" });
    return;
  }
  if (target === "cancelled_admin") {
    await kitchenStep("accepted");
    await orders.adminCancel(orderId, { reason: "Rider could not reach the customer", refund: "full" }, { userId: null, name: "Arjun Menon", role: "ops_manager" });
    return;
  }
  const steps = ["accepted", "preparing", "ready", "dispatched", "delivered"];
  for (const step of steps.slice(0, steps.indexOf(target) + 1)) {
    if (step === "dispatched" || step === "delivered") await orders.transition(orderId, step, { actor: "system", note: step === "dispatched" ? "Picked up by rider" : "Delivered" });
    else await kitchenStep(step);
  }
}

async function seedOrders(customers) {
  const demoUsers = Object.values(customers).map((item) => item.user._id);
  if (await Order.exists({ user: { $in: demoUsers } })) {
    logger.info("Demo orders already exist; skipping order history (use --fresh to rebuild)");
    return 0;
  }
  const random = rng(20261007);
  const today = istDateKey();
  let placed = 0;
  for (const customer of DEMO_CUSTOMERS) {
    const entry = customers[customer.phone];
    for (let index = 0; index < customer.orders; index += 1) {
      // Spread orders from sign-up to the customer's last order day (default yesterday).
      const last = customer.lastOrderDaysAgo || 1;
      const daysAgo = Math.max(last, Math.round(customer.days - ((index + 1) * (customer.days - last)) / customer.orders));
      const dinner = random() < 0.35;
      const plan = {
        slot: dinner ? "dinner" : "lunch",
        payment: ["upi", "upi", "upi", "card", "cod", "cod"][Math.floor(random() * 6)],
        coupon: index === 0 ? "WELCOME50" : random() < 0.15 ? "MEALJI20" : null,
      };
      const outcome = random();
      const target = outcome < 0.05 ? "cancelled_kitchen" : outcome < 0.08 && plan.payment !== "cod" ? "cancelled_admin" : "delivered";
      if (target === "cancelled_kitchen") plan.payment = "cod";
      const orderId = await placeDemoOrder(entry, plan, random);
      await advance(orderId, target, random);
      if (target === "delivered" && plan.payment === "cod") await invoiceOrder(await Order.findById(orderId).lean());
      if (target === "delivered" && random() < 0.65) {
        const food = random() < 0.75 ? 5 : random() < 0.6 ? 4 : 3;
        await orders.rateOrder(entry.user._id, orderId, { foodRating: food, deliveryRating: food >= 4 ? 5 : 4, comment: RATING_COMMENTS[Math.floor(random() * RATING_COMMENTS.length)], tags: food === 5 ? ["Tasty", "Fresh"] : ["Good portion"] });
      }
      const hour = dinner ? "19:" : "12:";
      const at = istDateTime(addIstDays(today, -daysAgo), `${hour}${String(10 + Math.floor(random() * 45)).padStart(2, "0")}`);
      await backdateOrder(orderId, at, random);
      placed += 1;
    }
  }
  // Today's live board: one order at each kitchen-side step.
  const live = [["9000000031", "placed"], ["9000000033", "preparing"], ["9000000032", "dispatched"], ["9000000037", "accepted"], ["9000000038", "ready"]];
  for (const [phone, target] of live) {
    const orderId = await placeDemoOrder(customers[phone], { slot: "lunch", payment: "upi", coupon: null }, random);
    if (target !== "placed") await advance(orderId, target, random);
    placed += 1;
  }
  return placed;
}

async function seedSubscriptions(customers) {
  const members = DEMO_CUSTOMERS.filter((customer) => customer.plus);
  let created = 0;
  for (const [index, customer] of members.entries()) {
    const { user, addressId } = customers[customer.phone];
    if (await Subscription.exists({ user: user._id })) continue;
    const planCode = index === 1 ? "LUNCH_WEEKLY" : "LUNCH_MONTHLY";
    const { payment } = await subscriptions.checkout(user._id, { planCode, billingMethod: index === 2 ? "link" : "autopay", addressId });
    await onPaymentCaptured(await Payment.findById(payment.paymentId), { gatewayPaymentId: `pay_demo_sub_${payment.paymentId}`, method: "upi" });
    created += 1;
  }
  return created;
}

// Subscribers pick lunch for their next few serving days (the kitchen's
// production sheet and the app's meal plan then have data).
async function seedMealPicks() {
  const random = rng(77);
  let picked = 0;
  for (const sub of await Subscription.find({ status: "active" }).lean()) {
    for (let offset = 1; offset <= 5; offset += 1) {
      const date = addIstDays(istDateKey(), offset);
      if (await MealSelection.exists({ subscription: sub._id, date })) continue;
      const menu = await slots.menuFor(sub.kitchen, "lunch", date);
      if (!menu?.dishes?.length) continue;
      const dish = menu.dishes[Math.floor(random() * menu.dishes.length)];
      try {
        await saveSelection(sub.user, { date, slot: "lunch", items: [{ dishId: dish.dishId, qty: 1 }] });
        picked += 1;
      } catch {
        // Not a serving day for this plan, or past the cutoff.
      }
    }
  }
  return picked;
}

async function seedTickets(customers) {
  const demoUsers = Object.values(customers).map((item) => item.user._id);
  if (await SupportTicket.exists({ user: { $in: demoUsers } })) return 0;
  const agent = await User.findOne({ phoneNumber: "9000000006" }).lean();
  const agentRef = { userId: agent?._id, name: agent?.name || "Support", role: "agent" };
  const recent = async (phone) => Order.findOne({ user: customers[phone].user._id, status: "delivered" }).sort({ createdAt: -1 }).lean();
  const tickets = [
    { phone: "9000000032", input: { category: "order", issueType: "Missing item", subject: "Raita missing from my order", description: "My order came without the boondi raita I paid for." }, order: true, reply: "Sorry about the missing raita! We've refunded it to your original payment method.", status: "resolved" },
    { phone: "9000000034", input: { category: "order", issueType: "Late delivery", subject: "Order arrived 30 minutes late", description: "The food was good but it came really late and was lukewarm." }, order: true, reply: "We're sorry your order arrived late. We've shared this with the kitchen and our delivery team.", status: "pending_customer" },
    { phone: "9000000035", input: { category: "payment", issueType: "Charged twice", subject: "Charged twice for one order", description: "I see two debits of the same amount on my UPI app for one order." }, order: true, status: "open" },
    { phone: "9000000033", input: { category: "subscription", issueType: "Change plan", subject: "Want to add dinner to my plan", description: "Can I add dinner to my monthly lunch plan from next week?" }, status: "open" },
    { phone: "9000000039", input: { category: "account", issueType: "Login", subject: "OTP not received", description: "I didn't get the OTP the first time I tried to sign in." }, reply: "The OTP can take up to a minute. If it doesn't arrive, tap Resend. Closing this for now.", status: "closed" },
  ];
  for (const ticket of tickets) {
    const { user } = customers[ticket.phone];
    const order = ticket.order ? await recent(ticket.phone) : null;
    const created = await support.createTicket(user._id, { ...ticket.input, orderId: order ? String(order._id) : undefined });
    if (ticket.reply) await support.addMessage(created.ticketId, { body: ticket.reply }, agentRef);
    if (ticket.status !== "open") await support.setStatus(created.ticketId, { status: ticket.status, assigneeId: agent?._id, assigneeName: agent?.name });
  }
  return tickets.length;
}

// Opens the demo kitchens around the clock while orders are placed, so the
// seed works at any time of day; their real hours are set afterwards.
async function withKitchensOpen(kitchens, run) {
  const ids = Object.values(kitchens).map((kitchen) => kitchen._id);
  await Kitchen.updateMany({ _id: { $in: ids } }, { $set: { opensAt: "00:00", closesAt: "23:59", weeklyHours: [], closures: [], acceptingOrders: true, status: "active" } });
  try {
    return await run();
  } finally {
    for (const [key, kitchen] of Object.entries(kitchens)) await Kitchen.updateOne({ _id: kitchen._id }, { $set: KITCHEN_SETUP[key].hours });
  }
}

// ------------------------------------------------------------------ entry

export async function seedDemoData({ fresh = false } = {}) {
  if (fresh) await wipeTestData();
  await seedAccounts();
  const kitchens = await demoKitchens();
  if (!kitchens.Koramangala || !kitchens.Indiranagar) throw new Error("Demo kitchens are missing; run the base seed first");
  const superadmin = await User.findOne({ phoneNumber: "9000000001" }).lean();
  const actor = { userId: superadmin?._id || null, name: superadmin?.name || "Seed", role: "superadmin" };

  await seedCatalog(kitchens);
  await seedKitchenOps(kitchens);
  await seedPlans();
  await seedContent(kitchens);
  await seedSupportAndRewards(kitchens);

  const customers = await seedAddresses(await demoKitchens());
  const { orderCount, subscriptionCount } = await withKitchensOpen(await demoKitchens(), async () => ({
    orderCount: await seedOrders(customers),
    subscriptionCount: await seedSubscriptions(customers),
  }));
  const ticketCount = await seedTickets(customers);
  const mealPicks = await seedMealPicks();

  // Dashboards, traits and segment sizes from the history just created.
  for (let offset = 0; offset <= 60; offset += 1) await rollupDay(addIstDays(istDateKey(), -offset));
  for (const customer of Object.values(customers)) await computeTraits(customer.user._id);
  await seedEngagement(actor);
  await segments.refreshSegmentSizes();

  logger.info({
    staff: DEMO_STAFF.map((item) => `${item.role}: ${item.phone}`),
    customers: `${DEMO_CUSTOMERS[0].phone}–${DEMO_CUSTOMERS.at(-1).phone}`,
    ordersPlaced: orderCount,
    subscriptions: subscriptionCount,
    tickets: ticketCount,
    mealPicks,
  }, "Demo data is ready");
}
