// Fills the LOAD database with a large, realistic amount of data on top of the
// normal seed: many customers with addresses, favourites, orders, searches and
// notifications, and big menus. Every generated document has loadTest: true.
//
//   npm run load:seed                         (normal seed + this, default sizes)
//   npm run load:generate -- --users=100000   (only this; sizes are per customer)
//
// Sizes: --users (50000) --dishes (200 per kitchen) --orders (4 per user)
// --favorites (5) --searches (10) --notifications (10) --reset (remove old load data first)
import "./loadEnv.js";
import mongoose from "mongoose";
import { env } from "../../src/config/env.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const SIZE = {
  users: arg("users", 50_000),
  dishesPerKitchen: arg("dishes", 200),
  ordersPerUser: arg("orders", 4),
  favoritesPerUser: arg("favorites", 5),
  searchesPerUser: arg("searches", 10),
  notificationsPerUser: arg("notifications", 10),
};
const RESET = process.argv.includes("--reset");
const BATCH = 5_000;
const PHONE_BASE = 7_000_000_000; // load customers: 7000000000 + n (never real SMS: isDemo, no SMS key)

const QUERIES = ["butter chicken", "biryani", "paneer", "bao", "ramen", "kulfi", "naan", "wrap", "cheesecake", "fries", "chicken", "veg", "dal", "coffee", "meal ji meal", "combo", "dessert", "spicy", "rice", "tikka"];
let seed = 42;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const daysAgo = (max) => new Date(Date.now() - random() * max * 86_400_000);
const near = (point, km) => ({ latitude: point.latitude + (random() - 0.5) * (km / 111), longitude: point.longitude + (random() - 0.5) * (km / 111) });

async function insertAll(collection, total, make) {
  const started = Date.now();
  let batch = [];
  for (let i = 0; i < total; i += 1) {
    batch.push(make(i));
    if (batch.length === BATCH || i === total - 1) {
      await collection.insertMany(batch, { ordered: false });
      batch = [];
    }
  }
  console.log(`  ${collection.collectionName}: +${total.toLocaleString("en-IN")} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

await mongoose.connect(env.mongoUri);
const db = mongoose.connection.db;
console.log(`Load data → ${db.databaseName}`, SIZE);

const kitchens = await db.collection("kitchens").find({ status: "active" }).toArray();
const role = await db.collection("roles").findOne({ slug: "user" });
if (!kitchens.length || !role) {
  console.error("Run the normal seed on the load database first: npm run load:seed");
  process.exit(1);
}

if (RESET) {
  for (const name of ["users", "addresses", "favorites", "searchlogs", "orders", "notifications", "kitchendishes", "couponredemptions", "carts"]) {
    const { deletedCount } = await db.collection(name).deleteMany({ loadTest: true });
    console.log(`  removed ${deletedCount} old load rows from ${name}`);
  }
}

// ---- big menus: fill each kitchen up to N live dishes (copies of real dishes)
for (const kitchen of kitchens) {
  const live = await db.collection("kitchendishes").find({ kitchen: kitchen._id, isActive: true, approvalStatus: "live" }).toArray();
  const missing = SIZE.dishesPerKitchen - live.length;
  if (missing > 0 && live.length) {
    await insertAll(db.collection("kitchendishes"), missing, (i) => {
      const { _id, masterDish, ...template } = pick(live);
      return { ...template, name: `${template.name} · ${i + 1}`, orderCount: Math.floor(random() * 500), ratingAvg: 3.5 + random() * 1.5, ratingCount: Math.floor(random() * 300), loadTest: true, createdAt: new Date(), updatedAt: new Date() };
    });
  }
}
const main = kitchens.find((kitchen) => /koramangala/i.test(kitchen.name)) || kitchens[0];
const dishes = await db.collection("kitchendishes").find({ kitchen: main._id, isActive: true, approvalStatus: "live" }).project({ _id: 1, name: 1, isVeg: 1, pricePaise: 1, images: 1 }).toArray();
const center = { latitude: main.latitude, longitude: main.longitude };

// ---- customers
const existing = await db.collection("users").countDocuments({ loadTest: true });
const toAdd = Math.max(0, SIZE.users - existing);
if (toAdd) {
  await insertAll(db.collection("users"), toAdd, (i) => {
    const n = existing + i;
    const point = near(center, 4);
    return {
      name: `Load User ${n}`,
      countryCode: "+91",
      phoneNumber: String(PHONE_BASE + n),
      role: role._id,
      isActive: true,
      isNumberVerified: true,
      isDemo: true,
      pointsBalance: Math.floor(random() * 2000),
      currentLocation: { ...point, locationText: "Koramangala, Bengaluru", area: "Koramangala", city: "Bengaluru", state: "Karnataka", postalCode: "560034", country: "India", updatedAt: new Date() },
      lastLoginAt: daysAgo(30),
      loadTest: true,
      createdAt: daysAgo(365),
      updatedAt: new Date(),
    };
  });
}
const users = await db.collection("users").find({ loadTest: true }).project({ _id: 1, name: 1, phoneNumber: 1 }).toArray();
const newUsers = users.slice(existing);

if (newUsers.length) {
  // ---- addresses (1–2 each)
  await insertAll(db.collection("addresses"), newUsers.length * 2, (i) => {
    const user = newUsers[i >> 1];
    const point = near(center, 4);
    return { user: user._id, label: i % 2 ? "work" : "home", houseFlat: `${(i % 300) + 1}, Load Residency`, street: "80 Feet Road", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", ...point, isDefault: i % 2 === 0, deletedAt: null, loadTest: true, createdAt: new Date(), updatedAt: new Date() };
  });
  // ---- favourites (unique dishes per user)
  await insertAll(db.collection("favorites"), newUsers.length * SIZE.favoritesPerUser, (i) => {
    const user = newUsers[Math.floor(i / SIZE.favoritesPerUser)];
    const dish = dishes[(i * 7 + Math.floor(i / SIZE.favoritesPerUser)) % dishes.length];
    return { user: user._id, dish: dish._id, loadTest: true, createdAt: daysAgo(120) };
  });
  // ---- searches
  await insertAll(db.collection("searchlogs"), newUsers.length * SIZE.searchesPerUser, (i) => {
    const query = pick(QUERIES);
    return { user: newUsers[Math.floor(i / SIZE.searchesPerUser)]._id, kitchen: main._id, query, normalized: query, results: Math.floor(random() * 12), clickedDish: null, hiddenFromRecent: false, loadTest: true, createdAt: daysAgo(30) };
  });
  // ---- order history
  const orderBase = await db.collection("orders").countDocuments();
  await insertAll(db.collection("orders"), newUsers.length * SIZE.ordersPerUser, (i) => {
    const user = newUsers[Math.floor(i / SIZE.ordersPerUser)];
    const lines = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const dish = pick(dishes);
      const qty = 1 + Math.floor(random() * 2);
      return { kind: "dish", dish: dish._id, name: dish.name, imageUrl: dish.images?.[0] || null, isVeg: dish.isVeg, qty, unitPricePaise: dish.pricePaise, totalPaise: dish.pricePaise * qty, dishIds: [{ dishId: String(dish._id), qty }] };
    });
    const total = lines.reduce((sum, line) => sum + line.totalPaise, 0);
    const createdAt = daysAgo(180);
    const status = random() < 0.9 ? "delivered" : "cancelled";
    return {
      orderNumber: `LT${String(orderBase + i).padStart(9, "0")}`, user: user._id, kitchen: main._id, kitchenName: main.name, city: main.city,
      items: lines, customer: { name: user.name, phone: user.phoneNumber }, deliveryMode: "delivery",
      bill: { itemsTotalPaise: total, deliveryFeePaise: 4000, grandTotalPaise: total + 4000 }, paymentMethod: "upi", paymentStatus: status === "delivered" ? "paid" : "refunded",
      status, statusHistory: [{ status, at: createdAt }], loadTest: true, createdAt, updatedAt: createdAt,
    };
  });
  // ---- notifications (about half unread)
  await insertAll(db.collection("notifications"), newUsers.length * SIZE.notificationsPerUser, (i) => ({
    user: newUsers[Math.floor(i / SIZE.notificationsPerUser)]._id, category: "order", title: "Your order was delivered", body: "Enjoy your meal!", isRead: random() < 0.5, readAt: null, loadTest: true, createdAt: daysAgo(60),
  }));
}

// ---- past coupon use (one per customer; also filled in for customers made by an earlier run)
if (!(await db.collection("couponredemptions").countDocuments({ loadTest: true }))) {
  const coupons = await db.collection("coupons").find({}).project({ _id: 1, code: 1 }).toArray();
  if (coupons.length) {
    await insertAll(db.collection("couponredemptions"), users.length, (i) => {
      const coupon = coupons[i % coupons.length];
      return { coupon: coupon._id, code: coupon.code, user: users[i]._id, discountPaise: 5000, status: "redeemed", loadTest: true, createdAt: daysAgo(90) };
    });
  }
}

// Make sure every index the API declares exists on the big collections.
const models = ["../../src/modules/coupon/coupon.model.js", "../../src/modules/cart/cart.model.js", "../../src/modules/user/user.model.js", "../../src/modules/address/address.model.js", "../../src/modules/favorites/favorites.model.js", "../../src/modules/order/order.model.js", "../../src/modules/notification/notification.model.js", "../../src/modules/catalog/catalog.model.js", "../../src/modules/search/search.routes.js"];
for (const file of models) await import(file);
await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes().catch((err) => console.warn(`  index sync ${model.modelName}: ${err.message}`))));

const counts = {};
for (const name of ["users", "addresses", "favorites", "searchlogs", "orders", "notifications", "kitchendishes"]) counts[name] = await db.collection(name).estimatedDocumentCount();
console.log("Load database now holds:", counts);
await mongoose.disconnect();
