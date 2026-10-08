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
import { rootDir } from "../src/config/env.js";
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
import { putFile, storageKey } from "../src/modules/upload/upload.service.js";

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

// ------------------------------------------------------------------ images

// Images come from the customer app (MealJi/src), so the seeded data looks
// exactly like the app's design. They are uploaded once to storage (S3 under
// S3_KEY_PREFIX, or ./uploads locally) at seed/<file> and reused afterwards.
const APP_SRC = path.resolve(rootDir, "..", "MealJi", "src");
const MENU = "design/assets/menu-v4";
const IMAGE_FILES = {
  // Dishes
  butterChickenBowl: `${MENU}/butter-chicken-bowl.jpg`,
  butterChickenDark: `${MENU}/butter-chicken-dark.jpg`,
  paneerBao: `${MENU}/paneer-bao.jpg`,
  dalRamen: `${MENU}/dal-ramen.jpg`,
  tikkaWrap: `${MENU}/tikka-wrap.jpg`,
  biryaniArancini: `${MENU}/biryani-arancini.jpg`,
  masalaFries: `${MENU}/masala-fries.jpg`,
  cauliflowerBowl: `${MENU}/cauliflower-bowl.jpg`,
  gulabCheesecake: `${MENU}/gulab-cheesecake.jpg`,
  kulfiShake: `${MENU}/kulfi-shake.jpg`,
  mealJiMeal: `${MENU}/meal-ji-meal.jpg`,
  paneerTikkaMasala: `${MENU}/paneer-tikka-masala.jpg`,
  chickenBiryani: `${MENU}/chicken-biryani.jpg`,
  muttonBiryani: `${MENU}/mutton-biryani.jpg`,
  paneerBiryani: `${MENU}/paneer-biryani.jpg`,
  eggBiryani: `${MENU}/egg-biryani.jpg`,
  butterNaan: `${MENU}/butter-naan.jpg`,
  garlicNaan: `${MENU}/rewards-garlic-naan.jpg`,
  jeeraRice: `${MENU}/jeera-rice.jpg`,
  coldDrink: `${MENU}/cold-drink.jpg`,
  coldCoffee: `${MENU}/rewards-cold-coffee.jpg`,
  chocolateCake: `${MENU}/chocolate-cake.jpg`,
  masalaPapad: `${MENU}/masala-papad.jpg`,
  gulabJamun: `${MENU}/rewards-gulab-jamun.jpg`,
  rewardsButterChicken: `${MENU}/rewards-butter-chicken.jpg`,
  // Combos
  comboSpread: `${MENU}/combo-spread.jpg`,
  completeMeal: `${MENU}/complete-meal.jpg`,
  mealWrapSolo: `${MENU}/meal-wrap-solo.jpg`,
  mealSharingPlate: `${MENU}/meal-sharing-plate.jpg`,
  mealBaoBowl: `${MENU}/meal-bao-bowl.jpg`,
  // Heroes, banners and the kitchen
  heroChickenBiryani: `${MENU}/hero-chicken-biryani.jpg`,
  heroButterChicken: `${MENU}/hero-butter-chicken.jpg`,
  heroButterChickenRice: `${MENU}/hero-butter-chicken-rice.jpg`,
  heroKitchenChef: `${MENU}/hero-kitchen-chef.jpg`,
  mealsHeroKitchen: `${MENU}/meals-hero-kitchen.jpg`,
  kitchenFlame: `${MENU}/kitchen-flame.jpg`,
  kitchenPrep: `${MENU}/kitchen-prep.jpg`,
  kitchenFresh: `${MENU}/kitchen-fresh.jpg`,
  liveKitchenChef: `${MENU}/live-kitchen-chef-3d.jpg`,
  dealsGiftbox: `${MENU}/deals-giftbox.webp`,
  dealsScooter: `${MENU}/deals-scooter.webp`,
  dealsChefKiss: `${MENU}/deals-chef-kiss.webp`,
  rewardsChefGift: `${MENU}/rewards-chef-gift.webp`,
  profileAvatar: `${MENU}/profile-avatar.jpg`,
  promoTaco: "assets/images/taco 1.png",
  mealCombos: "assets/images/Meal combos.png",
  howWeCook: "assets/images/Frame copy.png",
  onboardMenu: "assets/images/onboard2.png",
  onboardFresh: "assets/images/onboard3.png",
  mascot: "design/assets/brand-official/mascot-1024.png",
  logo: "design/assets/brand-official/logo-full.png",
};
const CONTENT_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const fileSlug = (file) => path.basename(file).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/-+/g, "-");

/** Uploads the app's images (skipping ones already stored) and returns name → URL. */
async function seedImages() {
  const urls = {};
  if (!fs.existsSync(APP_SRC)) {
    logger.warn({ appSrc: APP_SRC }, "Customer app not found next to the API; seeding without images");
    return urls;
  }
  for (const [name, file] of Object.entries(IMAGE_FILES)) {
    const source = path.join(APP_SRC, file);
    if (!fs.existsSync(source)) {
      logger.warn({ file }, "App image missing; skipped");
      continue;
    }
    const type = CONTENT_TYPES[path.extname(source).toLowerCase()];
    urls[name] = await putFile(storageKey(`seed/${fileSlug(file)}`), fs.readFileSync(source), type);
  }
  logger.info({ images: Object.keys(urls).length }, "App images are in storage");
  return urls;
}

// ------------------------------------------------------------------ menu (from the customer app)

// Today's Menu on the app's home shows Paneer, Daal and Roti first.
const MASTER_CATEGORIES = [
  { name: "Paneer", subtitle: "Paneer, every way you like it", image: "paneerBao", sortOrder: 0 },
  { name: "Daal & Curries", subtitle: "Slow-simmered comfort", image: "dalRamen", sortOrder: 1 },
  { name: "Roti & Rice", subtitle: "Fresh off the tawa", image: "butterNaan", sortOrder: 2 },
  { name: "Meal Ji Meals", subtitle: "The complete feast", image: "mealJiMeal", sortOrder: 3 },
  { name: "Signature Bowls", subtitle: "Our chef's signature bowls", image: "butterChickenBowl", sortOrder: 4 },
  { name: "Biryani", subtitle: "Dum-cooked, layered, fragrant", image: "chickenBiryani", sortOrder: 5 },
  { name: "Small Bites", subtitle: "Bao, wraps and street snacks", image: "biryaniArancini", sortOrder: 6 },
  { name: "Desserts & Shakes", subtitle: "Something sweet", image: "gulabCheesecake", sortOrder: 7 },
  { name: "Drinks", subtitle: "Chilled and refreshing", image: "coldDrink", sortOrder: 8 },
];

const RICE_PORTION = { name: "Choose Rice Portion", minSelect: 1, maxSelect: 1, options: [{ name: "Regular Jeera Rice" }, { name: "Extra Butter Jeera Rice", pricePaise: 4000 }, { name: "Fragrant Biryani Rice", pricePaise: 6000 }] };
const ADD_SIDE = { name: "Add a Side", minSelect: 0, maxSelect: 3, options: [{ name: "Crispy Masala Papad", pricePaise: 3900 }, { name: "Butter Garlic Naan (1 pc)", pricePaise: 6500 }, { name: "Cold Badam Drink", pricePaise: 7900 }] };
const EXTRA_DIP = { name: "Extra Dip", minSelect: 0, maxSelect: 2, options: [{ name: "Smoked Chilli Mayo", pricePaise: 2900 }, { name: "Pudina Chutney", pricePaise: 1900 }] };
const CHOOSE_BOWL = { name: "Choose your bowl", minSelect: 1, maxSelect: 1, options: [{ name: "Butter Chicken Bowl", isVeg: false }, { name: "Paneer Tikka Bowl" }] };

// [category, name, pricePaise, veg, image, extra fields]. The first ten are the app's own menu (menuData.ts).
const MASTER_DISHES = [
  ["Signature Bowls", "Butter Chicken Bowl", 34900, false, "butterChickenBowl", { originalPricePaise: 39900, badge: "Chef’s Kiss", description: "24-hr simmered makhani sauce, tender boneless chicken, fragrant cumin jeera rice.", story: "Chef Mujahid’s signature bowl, cooked over low flame with house-ground cardamom & churned cream.", calories: 620, spicyLevel: 1, preparationMinutes: 20, tags: ["bowl", "chicken", "bestseller"], cuisine: "North Indian", customizationGroups: [RICE_PORTION, ADD_SIDE] }],
  ["Paneer", "Paneer Bao (3 pcs)", 28900, true, "paneerBao", { originalPricePaise: 32900, badge: "Most Loved", description: "Puffy steamed bao buns stuffed with smoky clay-oven paneer, pickled onions & fresh mint mayo.", story: "East Asian technique meets Old Delhi tandoor mastery. Fluffy, spicy, tangy in every bite.", calories: 480, spicyLevel: 2, preparationMinutes: 15, tags: ["bao", "paneer", "bestseller"], cuisine: "Indo-Asian", customizationGroups: [EXTRA_DIP] }],
  ["Daal & Curries", "Dal Ramen", 29900, true, "dalRamen", { badge: "Trending", description: "Black dal simmered for 18 hours transformed into a rich velvety broth with handmade noodles & burnt garlic oil.", story: "An Indian food-lover’s ultimate comfort bowl. Deep, aromatic, finished with cilantro & butter swirls.", calories: 550, spicyLevel: 1, preparationMinutes: 18, tags: ["dal", "bowl", "noodles"], cuisine: "Indo-Asian" }],
  ["Small Bites", "Chicken Tikka Wrap", 27900, false, "tikkaWrap", { description: "Charcoal grilled chicken basted in mustard oil, wrapped in thin roomali with roasted peppers.", story: "Wrapped fresh off the tawa, served with charred green chilli dip.", calories: 510, spicyLevel: 2, preparationMinutes: 12, tags: ["wrap", "chicken"], cuisine: "North Indian" }],
  ["Small Bites", "Biryani Arancini (4 pcs)", 24900, true, "biryaniArancini", { description: "Golden spiced biryani croquettes with melted aged mozzarella centers & fiery salan glaze.", story: "Crisp outside, molten cheesy center bursting with saffron spices.", calories: 440, spicyLevel: 1, preparationMinutes: 14, tags: ["snack", "biryani"], cuisine: "Fusion" }],
  ["Meal Ji Meals", "The Meal Ji Meal (Signature)", 49900, false, "mealJiMeal", { originalPricePaise: 59900, badge: "Best Value", description: "The complete feast: Choice of Butter Chicken/Paneer Bowl + Masala Fries + Kulfi Shake + Garlic Naan.", story: "Designed for the hungriest. Everything you love about Meal Ji in one box.", calories: 950, preparationMinutes: 25, tags: ["meal", "signature", "bestseller"], cuisine: "North Indian", customizationGroups: [CHOOSE_BOWL] }],
  ["Signature Bowls", "Tandoori Cauliflower Bowl", 29900, true, "cauliflowerBowl", { description: "Whole spiced roasted florets on spiced quinoa pilaf with garlic labneh & pomegranate seeds.", story: "Wholesome, vibrant, gluten-friendly with immense smoky depth.", calories: 410, spicyLevel: 1, preparationMinutes: 18, tags: ["bowl", "healthy"], cuisine: "Modern Indian" }],
  ["Small Bites", "Masala Gunpowder Fries", 16900, true, "masalaFries", { description: "Hand-cut russet potatoes dusted with South Indian gunpowder spice and curry leaf salt.", story: "Crunchy hot fries that never stay in the box for long.", calories: 340, spicyLevel: 1, preparationMinutes: 10, tags: ["snack", "fries"], cuisine: "South Indian" }],
  ["Desserts & Shakes", "Gulab Cheesecake", 21900, true, "gulabCheesecake", { badge: "Must Try", description: "Velvety New York style cheesecake studded with miniature warm gulab jamuns & saffron glaze.", story: "The dessert that broke the internet. Sweet, decadent and unforgettable.", calories: 380, preparationMinutes: 5, tags: ["dessert", "bestseller"], cuisine: "Fusion" }],
  ["Desserts & Shakes", "Royal Kulfi Shake", 18900, true, "kulfiShake", { description: "Chilled thick shake spun with malai kulfi, toasted Iranian pistachios and green cardamom.", story: "Pure liquid gold served ice cold.", calories: 320, preparationMinutes: 8, tags: ["shake", "drink"], cuisine: "Indian" }],
  ["Paneer", "Paneer Tikka Masala", 29900, true, "paneerTikkaMasala", { description: "Char-grilled paneer tikka in a smoky onion-tomato masala with kasuri methi.", calories: 520, spicyLevel: 2, preparationMinutes: 18, tags: ["paneer", "curry"], cuisine: "North Indian" }],
  ["Daal & Curries", "Butter Chicken", 32900, false, "butterChickenDark", { description: "Our 24-hour makhani with tandoori chicken. Real butter, no cornstarch, no fillers.", calories: 580, spicyLevel: 1, preparationMinutes: 18, tags: ["chicken", "curry"], cuisine: "North Indian" }],
  ["Biryani", "Chicken Biryani", 32900, false, "chickenBiryani", { badge: "Signature", description: "Our signature dum biryani: aged basmati, bone-in chicken, saffron and fried onions. With salan and raita.", calories: 780, spicyLevel: 2, preparationMinutes: 22, tags: ["biryani", "chicken", "bestseller"], cuisine: "Hyderabadi" }],
  ["Biryani", "Mutton Biryani", 39900, false, "muttonBiryani", { description: "Tender mutton slow-cooked on dum with whole spices and aged basmati.", calories: 850, spicyLevel: 2, preparationMinutes: 25, tags: ["biryani", "mutton"], cuisine: "Hyderabadi" }],
  ["Biryani", "Paneer Biryani", 29900, true, "paneerBiryani", { description: "Paneer tikka layered with saffron basmati and mint.", calories: 690, spicyLevel: 1, preparationMinutes: 20, tags: ["biryani", "paneer"], cuisine: "Hyderabadi" }],
  ["Biryani", "Egg Biryani", 26900, false, "eggBiryani", { description: "Masala-roasted eggs on fragrant dum biryani rice.", calories: 640, spicyLevel: 2, preparationMinutes: 18, tags: ["biryani", "egg"], cuisine: "Hyderabadi" }],
  ["Roti & Rice", "Butter Naan", 5900, true, "butterNaan", { description: "Soft tandoor naan brushed with butter.", calories: 260, preparationMinutes: 6, tags: ["naan", "bread"], cuisine: "North Indian" }],
  ["Roti & Rice", "Garlic Naan", 6900, true, "garlicNaan", { description: "Naan topped with burnt garlic and coriander.", calories: 280, preparationMinutes: 6, tags: ["naan", "bread"], cuisine: "North Indian" }],
  ["Roti & Rice", "Jeera Rice", 14900, true, "jeeraRice", { description: "Aged basmati tossed with cumin and ghee.", calories: 310, preparationMinutes: 8, tags: ["rice"], cuisine: "North Indian" }],
  ["Small Bites", "Masala Papad", 7900, true, "masalaPapad", { description: "Crisp papad topped with onion, tomato and chaat masala.", calories: 120, preparationMinutes: 4, tags: ["snack"], cuisine: "North Indian" }],
  ["Desserts & Shakes", "Chocolate Truffle Cake", 19900, true, "chocolateCake", { description: "Rich dark chocolate truffle slice.", calories: 420, preparationMinutes: 3, tags: ["dessert", "cake"], cuisine: "Bakery" }],
  ["Desserts & Shakes", "Gulab Jamun (2 pcs)", 9900, true, "gulabJamun", { description: "Warm khoya gulab jamuns in cardamom syrup.", calories: 300, preparationMinutes: 3, tags: ["dessert"], cuisine: "North Indian" }],
  ["Drinks", "Chilled Soft Drink", 5900, true, "coldDrink", { description: "Ice-cold fizzy drink (300 ml).", calories: 140, preparationMinutes: 1, tags: ["drink", "cold"], cuisine: "Beverages" }],
  ["Drinks", "Cold Coffee", 14900, true, "coldCoffee", { description: "Thick cold coffee blended with vanilla ice cream.", calories: 260, preparationMinutes: 5, tags: ["drink", "coffee"], cuisine: "Beverages" }],
];

const BESTSELLERS = ["Butter Chicken Bowl", "Paneer Bao (3 pcs)", "The Meal Ji Meal (Signature)", "Chicken Biryani", "Gulab Cheesecake"];

const KITCHEN_SETUP = {
  Koramangala: {
    skip: [],
    combos: [
      { title: "Biryani Feast for 4", subtitle: "2 chicken, 1 mutton and 1 paneer biryani", image: "comboSpread", items: [["Chicken Biryani", 2], ["Mutton Biryani", 1], ["Paneer Biryani", 1]], pricePaise: 119900, originalPricePaise: 135600, isSignature: true, serves: 4, badge: "Party pack" },
      { title: "Sharing Platter for 2", subtitle: "2 butter chicken bowls, arancini and cheesecake", image: "mealSharingPlate", items: [["Butter Chicken Bowl", 2], ["Biryani Arancini (4 pcs)", 1], ["Gulab Cheesecake", 1]], pricePaise: 99900, originalPricePaise: 116600, isSignature: true, serves: 2, badge: "Save ₹167" },
      { title: "Complete Meal", subtitle: "Butter chicken, garlic naan, jeera rice and gulab jamun", image: "completeMeal", items: [["Butter Chicken", 1], ["Garlic Naan", 1], ["Jeera Rice", 1], ["Gulab Jamun (2 pcs)", 1]], pricePaise: 54900, originalPricePaise: 64600 },
      { title: "Bao & Bowl", subtitle: "Paneer bao with a dal ramen", image: "mealBaoBowl", items: [["Paneer Bao (3 pcs)", 1], ["Dal Ramen", 1]], pricePaise: 49900, originalPricePaise: 58800 },
      { title: "Solo Wrap Meal", subtitle: "Chicken tikka wrap, gunpowder fries and a drink", image: "mealWrapSolo", items: [["Chicken Tikka Wrap", 1], ["Masala Gunpowder Fries", 1], ["Chilled Soft Drink", 1]], pricePaise: 44900, originalPricePaise: 50700 },
    ],
    about: { chefName: "Chef Mujahid Khan", title: "The man behind the flame", story: "Every Meal Ji dish follows one standard. Our makhani simmers for 24 hours with real butter, ripe tomatoes and whole green cardamom, no cornstarch and no fillers. Baos and breads are puffed to order off the iron tawa and steam baskets, never reheated. And there are zero preservatives, so it's food you can enjoy four times a week.", image: "mealsHeroKitchen", gallery: ["heroKitchenChef", "kitchenFlame", "kitchenPrep", "kitchenFresh"] },
    hours: { opensAt: "08:00", closesAt: "23:00" },
  },
  Indiranagar: {
    skip: ["Mutton Biryani", "Egg Biryani"],
    combos: [
      { title: "Bao & Bowl", subtitle: "Paneer bao with a dal ramen", image: "mealBaoBowl", items: [["Paneer Bao (3 pcs)", 1], ["Dal Ramen", 1]], pricePaise: 49900, originalPricePaise: 58800, isSignature: true },
      { title: "Solo Wrap Meal", subtitle: "Chicken tikka wrap, gunpowder fries and a drink", image: "mealWrapSolo", items: [["Chicken Tikka Wrap", 1], ["Masala Gunpowder Fries", 1], ["Chilled Soft Drink", 1]], pricePaise: 44900, originalPricePaise: 50700 },
    ],
    about: { chefName: "Chef Meera Shah", title: "Same kitchen, same love", story: "Meera runs the Indiranagar kitchen with the same Meal Ji recipes: the 24-hour makhani, hand-made baos and breads, and nothing reheated. Every order is cooked and packed by the same small team.", image: "liveKitchenChef", gallery: ["kitchenPrep", "kitchenFresh"] },
    hours: { opensAt: "08:00", closesAt: "23:00" },
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

async function seedCatalog(kitchens, img) {
  const masterCategories = {};
  for (const { image, ...category } of MASTER_CATEGORIES) {
    const data = { ...category, imageUrl: img[image] || null };
    const found = await MasterCategory.findOne({ name: category.name }).lean();
    masterCategories[category.name] = found ? (await catalog.saveMasterCategory(String(found._id), data)).categoryId : (await catalog.saveMasterCategory(null, data)).categoryId;
  }
  const masterIds = {};
  const extras = new Map();
  for (const [categoryName, name, pricePaise, isVeg, image, { originalPricePaise, ...extra }] of MASTER_DISHES) {
    extras.set(name, { originalPricePaise: originalPricePaise ?? null, image });
    const data = { name, isVeg, suggestedPricePaise: pricePaise, categoryId: masterCategories[categoryName], servesCount: 1, images: img[image] ? [img[image]] : [], ...extra };
    const found = await MasterDish.findOne({ name }).lean();
    masterIds[name] = found ? (await catalog.saveMasterDish(String(found._id), data)).masterDishId : (await catalog.saveMasterDish(null, data)).masterDishId;
  }

  for (const [key, kitchen] of Object.entries(kitchens)) {
    const setup = KITCHEN_SETUP[key];
    const kitchenId = kitchen._id;
    for (const { image, ...category } of MASTER_CATEGORIES) {
      let row = await KitchenCategory.findOne({ kitchen: kitchenId, name: category.name }).lean();
      if (!row) row = { _id: (await catalog.createCategory(kitchenId, { ...category, imageUrl: img[image] || null })).categoryId };
      else await KitchenCategory.updateOne({ _id: row._id }, { $set: { imageUrl: img[image] || null, sortOrder: category.sortOrder, subtitle: category.subtitle } });
      const wanted = MASTER_DISHES.filter(([categoryName, name]) => categoryName === category.name && !setup.skip.includes(name)).map(([, name]) => masterIds[name]);
      if (wanted.length) {
        const missing = [];
        for (const id of wanted) if (!(await KitchenDish.exists({ kitchen: kitchenId, masterDish: id }))) missing.push(id);
        if (missing.length) await catalog.importMasterDishes(kitchenId, { masterDishIds: missing, categoryId: String(row._id) }, { platform: true });
      }
    }
    // Slots, bestsellers, MRP and the app's photo on every dish.
    const dishes = await KitchenDish.find({ kitchen: kitchenId }).lean();
    const byName = new Map(dishes.map((dish) => [dish.name, dish]));
    for (const dish of dishes) {
      const extra = extras.get(dish.name) || {};
      await KitchenDish.updateOne({ _id: dish._id }, { $set: {
        availableSlots: ["lunch", "dinner", "snacks"],
        isBestseller: BESTSELLERS.includes(dish.name),
        originalPricePaise: extra.originalPricePaise ?? null,
        ...(img[extra.image] ? { images: [img[extra.image]] } : {}),
      } });
    }
    for (const { image, ...combo } of setup.combos) {
      const data = { ...combo, imageUrl: img[image] || null, items: combo.items.map(([name, qty]) => ({ dishId: String(byName.get(name)._id), qty })) };
      const found = await KitchenCombo.findOne({ kitchen: kitchenId, title: combo.title }).lean();
      if (found) await KitchenCombo.updateOne({ _id: found._id }, { $set: { imageUrl: data.imageUrl } });
      else await catalog.createCombo(kitchenId, data, { platform: true });
    }
    await catalog.invalidateMenu(kitchenId, "seed");
  }
}

// ------------------------------------------------------------------ kitchens

const SLOT_TIMES = {
  breakfast: { windowStart: "07:30", windowEnd: "09:30", cutoffDay: "previous_day", cutoffTime: "21:00", prepStart: "06:30", dispatchTime: "07:15", capacity: 80 },
  lunch: { windowStart: "12:30", windowEnd: "14:30", cutoffDay: "same_day", cutoffTime: "10:00", prepStart: "10:30", dispatchTime: "12:00", capacity: 150 },
  dinner: { windowStart: "19:30", windowEnd: "21:30", cutoffDay: "same_day", cutoffTime: "17:00", prepStart: "17:30", dispatchTime: "19:00", capacity: 120 },
};

// Weekly rotation for subscription menus (index = weekday, 0 = Sunday).
const LUNCH_ROTATION = [
  ["Butter Chicken Bowl", "Dal Ramen", "Paneer Biryani"],
  ["Chicken Biryani", "Tandoori Cauliflower Bowl", "Paneer Tikka Masala"],
  ["Butter Chicken", "Dal Ramen", "Jeera Rice"],
  ["The Meal Ji Meal (Signature)", "Paneer Bao (3 pcs)", "Tandoori Cauliflower Bowl"],
  ["Chicken Biryani", "Paneer Tikka Masala", "Garlic Naan"],
  ["Butter Chicken Bowl", "Paneer Biryani", "Dal Ramen"],
  ["Egg Biryani", "Paneer Tikka Masala", "Butter Naan"],
];
const BREAKFAST_ROTATION = ["Paneer Bao (3 pcs)", "Chicken Tikka Wrap", "Royal Kulfi Shake", "Cold Coffee", "Biryani Arancini (4 pcs)"];

async function seedKitchenOps(kitchens, img) {
  for (const [key, kitchen] of Object.entries(kitchens)) {
    const { about } = KITCHEN_SETUP[key];
    const update = { about: { chefName: about.chefName, title: about.title, story: about.story, imageUrl: img[about.image] || null, gallery: about.gallery.map((name) => img[name]).filter(Boolean) } };
    if (kitchen.status !== "active") Object.assign(update, { status: "active", acceptingOrders: true });
    await Kitchen.updateOne({ _id: kitchen._id }, { $set: update });

    for (const [slot, times] of Object.entries(SLOT_TIMES)) await slots.saveSlot(kitchen._id, slot, times);
    const dishes = new Map((await KitchenDish.find({ kitchen: kitchen._id, isActive: true }).lean()).map((dish) => [dish.name, String(dish._id)]));
    const ids = (names) => names.map((name) => dishes.get(name)).filter(Boolean);
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const lunch = ids(LUNCH_ROTATION[weekday]);
      if (lunch.length) await slots.saveSlotMenu(kitchen._id, { slot: "lunch", weekday, dishIds: lunch, defaultDishIds: lunch.slice(0, 1), note: null });
      const dinner = ids(LUNCH_ROTATION[(weekday + 3) % 7]);
      if (dinner.length) await slots.saveSlotMenu(kitchen._id, { slot: "dinner", weekday, dishIds: dinner, defaultDishIds: dinner.slice(0, 1) });
      const breakfast = ids([0, 1, 2].map((offset) => BREAKFAST_ROTATION[(weekday + offset) % BREAKFAST_ROTATION.length]));
      if (breakfast.length) await slots.saveSlotMenu(kitchen._id, { slot: "breakfast", weekday, dishIds: breakfast, defaultDishIds: breakfast.slice(0, 1) });
    }
  }
}

// ------------------------------------------------------------------ plans (the app's MealJi Plus cards)

const PLAN_BASE = { cycleDays: 30, cycleLabel: "Monthly", slots: ["breakfast", "lunch", "dinner"], activeDays: [1, 2, 3, 4, 5, 6], mealsPerDay: 3, minItemsPerMeal: 1, billingMethods: ["autopay", "link"], noSelectionPolicy: "auto_shift", autoShiftFallback: "chef_default", maxShiftsPerCycle: 4, maxAutoShiftsPerCycle: 6, deliveryIncluded: true };
const PLANS = [
  { ...PLAN_BASE, code: "BASIC_MONTHLY", name: "Basic Monthly", subtitle: "Simple and light meals", image: "mealsHeroKitchen", pricePaise: 349900, maxItemsPerMeal: 1, benefits: ["3+ Food Categories", "3 meals / Day", "Free doorstep delivery", "2 vegetable dishes", "Fresh salad", "4 chapatis", "1 sweet"], sortOrder: 1 },
  { ...PLAN_BASE, code: "STANDARD_MONTHLY", name: "Standard Monthly", subtitle: "Everyday healthy home meals", image: "completeMeal", badge: "Most popular", isPopular: true, pricePaise: 449900, maxItemsPerMeal: 2, benefits: ["5+ Food Categories", "3 meals / Day", "Free doorstep delivery", "2 vegetable dishes", "Fresh salad", "4 chapatis", "1 sweet"], perks: { freeDeliveryOnOrders: true, orderDiscountPercent: 10 }, sortOrder: 2 },
  // The app's card says "4 meals / Day"; plans support up to 3 slots, so Premium is 3 larger meals.
  { ...PLAN_BASE, code: "PREMIUM_MONTHLY", name: "Premium Monthly", subtitle: "Gourmet meals for foodies", image: "comboSpread", pricePaise: 549900, maxItemsPerMeal: 3, benefits: ["7+ Food Categories", "3 meals / Day", "Free doorstep delivery", "3 vegetable dishes", "Fresh salad", "5 chapatis", "2 sweets"], perks: { freeDeliveryOnOrders: true, orderDiscountPercent: 15 }, sortOrder: 3 },
];

async function seedPlans(img) {
  for (const { image, ...plan } of PLANS) {
    const data = { ...plan, imageUrl: img[image] || null, cities: ["Bengaluru"] };
    const row = await SubscriptionPlan.findOne({ code: plan.code }).lean();
    if (!row) {
      const created = await plans.savePlan(null, data);
      await plans.setPlanStatus(created.planId, "active");
    } else if (row.status !== "retired") {
      await SubscriptionPlan.updateOne({ _id: row._id }, { $set: { imageUrl: data.imageUrl } });
    }
  }
}

// ------------------------------------------------------------------ content & offers (start → home)

async function seedContent(kitchens, img) {
  // Placements follow the app's home: promo strip in the header, the
  // signature carousel (4 slides), the Meal Combos card and How we cook.
  const banners = [
    { placement: "home_promo", title: "Foodie Weekend", subtitle: "Flat ₹150 OFF on delights!", ctaLabel: "ORDER NOW", couponCode: "FOODIE150", deepLink: "mealji://offers", image: "promoTaco", sortOrder: 0 },
    { placement: "home_hero", eyebrow: "OUR SIGNATURE CHICKEN BIRYANI", title: "A BOWL OF HAPPINESS", highlight: "HAPPINESS", subtitle: "Rich flavours. Freshly cooked. Always for you.", ctaLabel: "Order Now", deepLink: "mealji://menu?category=biryani", image: "heroChickenBiryani", sortOrder: 0 },
    { placement: "home_hero", eyebrow: "24-HOUR MAKHANI", title: "BUTTER CHICKEN, DONE RIGHT", highlight: "DONE RIGHT", subtitle: "Real butter. No cornstarch. No shortcuts.", ctaLabel: "Order Now", deepLink: "mealji://menu?category=signature-bowls", image: "heroButterChicken", sortOrder: 1 },
    { placement: "home_hero", eyebrow: "NEW HERE?", title: "₹100 OFF YOUR FIRST ORDER", highlight: "₹100 OFF", subtitle: "Use code WELCOME100 on orders above ₹299.", ctaLabel: "Order Now", couponCode: "WELCOME100", deepLink: "mealji://menu", image: "heroButterChickenRice", sortOrder: 2 },
    { placement: "home_hero", eyebrow: "MEAL JI PLUS", title: "MEALS SORTED FOR THE MONTH", highlight: "SORTED", subtitle: "Plans from ₹3,499 a month with free delivery.", ctaLabel: "See plans", deepLink: "mealji://plus", image: "heroKitchenChef", sortOrder: 3 },
    { placement: "home_combos", title: "MEAL COMBOS", highlight: "COMBOS", subtitle: "Great food. Better together.", ctaLabel: "Explore Combos", deepLink: "mealji://menu?tab=combos", image: "mealCombos", sortOrder: 0 },
    { placement: "home_how_we_cook", title: "How we cook", subtitle: "24-hour makhani, breads puffed to order, zero preservatives.", deepLink: "mealji://about-chef", image: "howWeCook", sortOrder: 0 },
    { placement: "menu_hero", title: "Today's bestsellers", subtitle: "What Bengaluru is ordering right now", deepLink: "mealji://menu?sort=popular", image: "comboSpread", sortOrder: 0 },
    { placement: "offers", title: "Flat ₹150 off this weekend", subtitle: "Code FOODIE150 on orders above ₹599", couponCode: "FOODIE150", image: "dealsGiftbox", sortOrder: 0 },
    { placement: "offers", title: "Free delivery above ₹249", subtitle: "Code FREEDEL", couponCode: "FREEDEL", image: "dealsScooter", sortOrder: 1 },
    { placement: "offers", title: "20% off up to ₹100", subtitle: "Code MEALJI20 on orders above ₹299", couponCode: "MEALJI20", image: "dealsChefKiss", sortOrder: 2 },
  ];
  for (const { image, ...banner } of banners) {
    const data = { ...banner, imageUrl: img[image] || null, cities: ["Bengaluru"], isActive: true };
    const found = await Banner.findOne({ placement: banner.placement, title: banner.title }).lean();
    await content.saveBanner(found ? String(found._id) : null, data);
  }

  // The app's three onboarding steps.
  const slides = [
    { title: "Hey. I'm the chef at Meal Ji.", subtitle: "One kitchen. One menu. Cooked and packed by the same people every time.", image: "mascot", sortOrder: 0 },
    { title: "A short menu. Every dish, a hero.", subtitle: "Nine signature bowls, bao, wraps and desserts. No filler. No maybes.", image: "onboardMenu", sortOrder: 1 },
    { title: "Made in the last hour. Delivered warm.", subtitle: "Every dish is fresh out the pan. We deliver in 25–35 minutes, or you pick it up in 15.", image: "onboardFresh", sortOrder: 2 },
  ];
  for (const { image, ...slide } of slides) {
    const found = await OnboardingSlide.findOne({ title: slide.title }).lean();
    await content.saveSlide(found ? String(found._id) : null, { ...slide, imageUrl: img[image] || null, isActive: true });
  }

  // Home layout in the app's order.
  await content.saveSections([
    { key: "promo", type: "banners", config: { placement: "home_promo" } },
    { key: "hero", type: "banners", config: { placement: "home_hero" } },
    { key: "categories", type: "categories", title: "Today's Menu" },
    { key: "combos", type: "combos", title: "Meal Combos", config: { placement: "home_combos" } },
    { key: "features", type: "features", config: { items: [{ icon: "fast_delivery", title: "Fast Delivery", subtitle: "25—35 mins" }, { icon: "fresh_ingredients", title: "Fresh Ingredients", subtitle: "Locally sourced" }, { icon: "hygienic_kitchen", title: "Hygienic Kitchen", subtitle: "100% safe" }] } },
    { key: "usual", type: "usual", title: "Your usual?", subtitle: "Order again in one tap", config: { limit: 6 } },
    { key: "plus", type: "subscription_promo", title: "Meal Ji Plus" },
    { key: "how_we_cook", type: "how_we_cook", title: "How we cook", config: { placement: "home_how_we_cook" } },
    { key: "popular", type: "popular", title: "Popular today", config: { limit: 8 } },
  ]);

  const now = Date.now();
  const offers = [
    { code: "WELCOME100", title: "₹100 off your first order", description: "For your first Meal Ji order", type: "flat", value: 10000, minOrderPaise: 29900, firstOrderOnly: true, perUserLimit: 1, terms: ["Valid on your first order only", "Minimum order ₹299"] },
    { code: "FOODIE150", title: "Foodie Weekend: flat ₹150 off", description: "On orders above ₹599", type: "flat", value: 15000, minOrderPaise: 59900, perUserLimit: 2, terms: ["Minimum order ₹599", "Up to 2 times per customer"] },
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
    const created = await billing.createEntity({ legalName: "MealJi Foods Private Limited", tradeName: "Meal Ji", gstin: "29AAQCM4821K1Z7", fssai: "11225999000123", pan: "AAQCM4821K", addressLine: "3rd Floor, 80 Feet Road, 4th Block, Koramangala", city: "Bengaluru", state: "Karnataka", stateCode: "29", pincode: "560034", email: "billing@mealji.example", phone: "08040001234", invoicePrefix: "MJ", logoUrl: img.logo || null, signatory: "Authorised signatory", isDefault: true, isActive: true });
    entity = { _id: created.entityId };
  } else if (img.logo) {
    await BillingEntity.updateOne({ _id: entity._id }, { $set: { logoUrl: img.logo } });
  }
  for (const kitchen of Object.values(kitchens)) if (!kitchen.billingEntity) await billing.mapKitchen(String(kitchen._id), String(entity._id));
  if (!(await DeliveryProviderAccount.exists({ name: "MealJi riders (manual dispatch)" }))) {
    await delivery.saveProviderAccount(null, { provider: "manual", name: "MealJi riders (manual dispatch)", cities: ["bengaluru"], credentials: {}, isActive: true });
  }
}

// ------------------------------------------------------------------ support & loyalty

async function seedSupportAndRewards(kitchens, img) {
  for (const [index, category] of (await support.listCategories({ all: true })).entries()) {
    await support.saveCategory(category.key, { name: category.name, icon: category.icon, issueTypes: category.issueTypes, context: category.context || "both", slaHours: category.key === "order" ? 2 : category.key === "payment" ? 12 : 24, sortOrder: index, isActive: true });
  }
  const faqs = [
    ["order", "Where is my order?", "Open Orders and tap your order to track it live. You'll also get updates when it's accepted, picked up and delivered."],
    ["order", "Can I cancel my order?", "You can cancel before the kitchen accepts it. After that, contact us from the order screen and we'll help."],
    ["payment", "When will I get my refund?", "Refunds reach UPI within 1-3 working days and cards within 5-7 working days."],
    ["payment", "Is cash on delivery available?", "Yes, for orders up to the limit shown at checkout."],
    ["account", "How do I change my phone number?", "Go to Profile, then Phone number, and verify the new number with an OTP."],
    ["subscription", "How do I pause Meal Ji Plus?", "Open Meal Ji Plus, tap Manage, then Pause. You can pause for 1 to 3 months.", "subscription"],
    ["subscription", "What if I forget to pick my meal?", "If you don't choose by the cutoff, we send the chef's pick for the day, so you never miss a meal.", "subscription"],
  ];
  for (const [index, [category, question, answer, context]] of faqs.entries()) {
    if (!(await Faq.exists({ question }))) await support.saveFaq(null, { category, question, answer, context: context || "default", sortOrder: index, isActive: true });
  }
  const canned = [
    ["Apology – late delivery", "We're sorry your order arrived late. We've shared this with the kitchen and our delivery team so it doesn't happen again.", "order"],
    ["Refund initiated", "We've started your refund. It reaches UPI within 1-3 working days and cards within 5-7 working days.", "payment"],
    ["Missing item – refund", "Sorry about the missing item. We've refunded it to your original payment method.", "order"],
    ["Pause instructions", "You can pause Meal Ji Plus from the app: Meal Ji Plus → Manage → Pause. Choose 1 to 3 months.", "subscription"],
    ["Closing – resolved", "Glad we could sort this out! We're closing this ticket; reply anytime if you need more help.", null],
  ];
  for (const [title, body, category] of canned) if (!(await CannedReply.exists({ title }))) await support.saveCanned(null, { title, body, category });

  // The app's rewards screen shows dish rewards (garlic naan, gulab jamun, cold coffee, butter chicken).
  const dish = async (name) => (await KitchenDish.findOne({ kitchen: kitchens.Koramangala?._id, name }).lean())?._id;
  const catalogRewards = [
    { name: "Free Garlic Naan", description: "Added to your next order", points: 300, kind: "dish", value: 0, dishName: "Garlic Naan", image: "garlicNaan", validDays: 15, sortOrder: 0 },
    { name: "Free Gulab Jamun", description: "Added to your next order", points: 400, kind: "dish", value: 0, dishName: "Gulab Jamun (2 pcs)", image: "gulabJamun", validDays: 15, sortOrder: 1 },
    { name: "Free Cold Coffee", description: "Added to your next order", points: 600, kind: "dish", value: 0, dishName: "Cold Coffee", image: "coldCoffee", validDays: 15, sortOrder: 2 },
    { name: "₹50 off your next order", description: "Minimum order ₹199", points: 500, kind: "flat", value: 5000, minOrderPaise: 19900, image: "rewardsChefGift", validDays: 30, sortOrder: 3 },
    { name: "Free delivery", description: "On any one order", points: 300, kind: "free_delivery", value: 0, image: "dealsScooter", validDays: 30, sortOrder: 4 },
    { name: "Free Butter Chicken (Gold Kadai & above)", description: "Our 24-hour makhani, on us", points: 1500, kind: "dish", value: 0, dishName: "Butter Chicken", image: "rewardsButterChicken", validDays: 30, tiers: ["Gold Kadai", "Black Makhani"], sortOrder: 5 },
  ];
  for (const { dishName, image, ...reward } of catalogRewards) {
    const data = { ...reward, imageUrl: img[image] || null, isActive: true };
    if (dishName) {
      const dishId = await dish(dishName);
      if (!dishId) continue;
      data.dishId = String(dishId);
    }
    const found = await Reward.findOne({ name: reward.name }).lean();
    await rewards.saveReward(found ? String(found._id) : null, data);
  }
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
  if (!(await Campaign.exists({ name: "Foodie Weekend comeback" }))) {
    await campaigns.saveCampaign(null, { name: "Foodie Weekend comeback", objective: "Bring lapsed customers back with the Foodie Weekend offer", channels: ["inapp", "push"], audience: "segment", segmentId: ids["Lapsed 14+ days"], variants: [{ key: "A", templateKey: "campaign.generic", weight: 1 }], holdoutPercent: 10, data: { title: "Foodie Weekend is here", body: "Flat ₹150 off with FOODIE150 on orders above ₹599." }, couponCode: "FOODIE150", deepLink: "mealji://offers" }, actor);
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
    // The app's "Deliver to" pin: the customer's own address (never a stale test location).
    const pin = await Address.findById(address._id).lean();
    await User.updateOne({ _id: user._id }, { $set: { currentLocation: { latitude: pin.latitude, longitude: pin.longitude, locationText: `${pin.houseFlat}, ${pin.locality}`, area: pin.locality, city: pin.city, state: pin.state, postalCode: pin.pincode } } });
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
        coupon: index === 0 ? "WELCOME100" : random() < 0.15 ? "MEALJI20" : null,
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
    const planCode = ["STANDARD_MONTHLY", "BASIC_MONTHLY", "PREMIUM_MONTHLY"][index % 3];
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
      for (const slot of sub.planSnapshot?.slots || ["lunch"]) {
        if (await MealSelection.exists({ subscription: sub._id, date, slot, status: { $ne: "open" } })) continue;
        const menu = await slots.menuFor(sub.kitchen, slot, date);
        if (!menu?.dishes?.length) continue;
        const dish = menu.dishes[Math.floor(random() * menu.dishes.length)];
        try {
          await saveSelection(sub.user, { date, slot, items: [{ dishId: dish.dishId, qty: 1 }] });
          picked += 1;
        } catch {
          // Not a serving day for this plan, or past the cutoff.
        }
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
    { phone: "9000000032", input: { category: "order", issueType: "Missing item", subject: "Masala papad missing from my order", description: "My order came without the masala papad I paid for." }, order: true, reply: "Sorry about the missing papad! We've refunded it to your original payment method.", status: "resolved" },
    { phone: "9000000034", input: { category: "order", issueType: "Late delivery", subject: "Order arrived 30 minutes late", description: "The food was good but it came really late and was lukewarm." }, order: true, reply: "We're sorry your order arrived late. We've shared this with the kitchen and our delivery team.", status: "pending_customer" },
    { phone: "9000000035", input: { category: "payment", issueType: "Charged twice", subject: "Charged twice for one order", description: "I see two debits of the same amount on my UPI app for one order." }, order: true, status: "open" },
    { phone: "9000000033", input: { category: "subscription", issueType: "Change plan", subject: "Want to upgrade to Premium", description: "Can I move from Standard to Premium Monthly from next week?" }, status: "open" },
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

  const img = await seedImages();
  if (img.profileAvatar) await User.updateOne({ phoneNumber: "9000000031" }, { $set: { avatarUrl: img.profileAvatar } });
  await seedCatalog(kitchens, img);
  await seedKitchenOps(kitchens, img);
  await seedPlans(img);
  await seedContent(kitchens, img);
  await seedSupportAndRewards(kitchens, img);

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
