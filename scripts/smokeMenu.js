// Live checks for menu, dish, combo, search and favourites endpoints: security,
// the app's data contract and edge cases. Each check states the CORRECT
// behaviour, so a failing check is an open issue. Runs against a running API
// with the seeded demo data; needs FIXED_OTP (development). Everything it
// creates is removed again.
//
//   npm run smoke:menu
//   SMOKE_API=https://staging.example.com npm run smoke:menu

import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { istParts } from "../src/common/time.js";

const ROOT = String(process.env.SMOKE_API || `http://localhost:${env.port || 4000}`).replace(/\/$/, "");
const BASE = `${ROOT}/api/v1`;
const results = [];
const cleanups = [];
let section = "";

function record(ok, name, detail = "", ref = "") {
  results.push({ section, ok, name, detail, ref });
  console.log(`${ok ? "  ✓" : "  ✗"} ${ref ? `[${ref}] ` : ""}${name}${detail ? ` — ${detail}` : ""}`);
}
const group = (name) => { section = name; console.log(`\n${name}`); };
const check = (cond, name, detail = "", ref = "") => record(Boolean(cond), name, detail, ref);

class Client {
  constructor(deviceId) {
    this.headers = { "Content-Type": "application/json", "x-device-id": deviceId };
  }
  async call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, data: json?.data };
  }
}
async function signIn(client, phone, staff = false) {
  const login = await client.call("POST", staff ? "/auth/staff-login" : "/auth/login", { countryCode: "+91", phoneNumber: phone });
  const verify = await client.call("POST", "/auth/verify-otp", { userId: login.data?.userId, otp: env.fixedOtp });
  client.headers.Authorization = `Bearer ${verify.data?.accessToken}`;
  return verify.data;
}
const list = (data) => (Array.isArray(data) ? data : data?.items || data?.dishes || []);

async function main() {
  if (!env.fixedOtp) throw new Error("FIXED_OTP is not set");
  console.log(`Menu smoke test against ${BASE}`);
  const app = new Client("smoke-menu-device-1");
  const admin = new Client("smoke-menu-admin-01");
  await signIn(app, "9000000031");
  await signIn(admin, "9000000001", true);
  const home = await app.call("GET", "/home");
  const kitchenId = home.data?.kitchen?.kitchenId;
  const kq = `kitchenId=${kitchenId}`;
  await mongoose.connect(env.mongoUri);
  const db = mongoose.connection.db;
  const indiranagar = await db.collection("kitchens").findOne({ phoneNumber: "9000000021" });
  const otherDish = await db.collection("kitchendishes").findOne({ kitchen: indiranagar._id, approvalStatus: "live", isActive: true });

  // ------------------------------------------------------------ security
  group("1. Security");
  for (const path of ["/SEARCH/TRENDING", "/Menu/categories", "/HOME", "/Users/me/favorites", "/Dishes"]) {
    const res = await fetch(`${BASE}${path}`);
    check(res.status === 401, `no token + odd letter case is refused: ${path}`, String(res.status), "1");
  }
  const crash = await fetch(`${BASE}/Menu/categories`).then((res) => res.json()).catch(() => ({}));
  check(!/Cannot read|undefined|TypeError/.test(String(crash.message)), "errors never show internal JavaScript messages", crash.message, "1");

  // Unpublished dish: never visible or favouritable.
  const pending = await db.collection("kitchendishes").insertOne({ kitchen: new mongoose.Types.ObjectId(kitchenId), name: "SMOKE PENDING DISH", pricePaise: 100, isActive: true, isAvailable: true, approvalStatus: "pending", isVeg: true, images: [], customizationGroups: [], portions: [], tags: [], highlights: [], availableSlots: [], availableDays: [], createdAt: new Date(), updatedAt: new Date() });
  cleanups.push(() => db.collection("kitchendishes").deleteOne({ _id: pending.insertedId }));
  cleanups.push(() => app.call("DELETE", `/users/me/favorites/${pending.insertedId}`));
  const favPending = await app.call("POST", "/users/me/favorites", { dishId: String(pending.insertedId) });
  check(favPending.status === 404, "a dish waiting for approval cannot be favourited", String(favPending.status), "4");
  const favList = await app.call("GET", "/users/me/favorites");
  check(!list(favList.data).some((dish) => dish.name === "SMOKE PENDING DISH"), "favourites never list unpublished dishes", "", "4");

  // ------------------------------------------------------------ availability
  group("2. Availability");
  const hour = istParts(new Date()).hour;
  const otherSlot = hour >= 11 ? "breakfast" : "dinner";
  const cat = await admin.call("POST", `/admin/kitchens/${kitchenId}/menu/categories`, { name: "SMOKE CATEGORY", isActive: true });
  const catId = cat.data?.categoryId;
  if (catId) cleanups.push(() => admin.call("DELETE", `/admin/kitchens/${kitchenId}/menu/categories/${catId}`));
  const slotDish = await admin.call("POST", `/admin/kitchens/${kitchenId}/menu/dishes`, { name: `SMOKE ${otherSlot.toUpperCase()} ONLY`, pricePaise: 9900, isVeg: true, categoryId: catId, availableSlots: [otherSlot] });
  const slotDishId = slotDish.data?.dish?.dishId;
  if (slotDishId) cleanups.unshift(() => admin.call("DELETE", `/admin/kitchens/${kitchenId}/menu/dishes/${slotDishId}`));
  const slotView = await app.call("GET", `/menu/items/${slotDishId}?${kq}`);
  check(slotView.data && slotView.data.isAvailable === false, `a ${otherSlot}-only dish is not orderable now (${hour}:xx IST)`, `isAvailable ${slotView.data?.isAvailable}`, "2");
  check(slotView.data && "unavailableReason" in slotView.data, "unavailable dishes say why (unavailableReason)", String(slotView.data?.unavailableReason), "13");
  check(slotView.data && Array.isArray(slotView.data.availableDays), "dishes include availableDays", "", "13");

  const dishesRes = await app.call("GET", `/dishes?${kq}`);
  check(dishesRes.data?.kitchen && "isOpenNow" in dishesRes.data.kitchen, "menu responses say whether the kitchen is open now", JSON.stringify(dishesRes.data?.kitchen), "3");

  // Hidden category: its dishes disappear everywhere.
  const hidden = await admin.call("PATCH", `/admin/kitchens/${kitchenId}/menu/categories/${catId}`, { isActive: false });
  check(hidden.status === 200, "hide the test category", String(hidden.status));
  const sorted = await app.call("GET", `/dishes?${kq}&sort=popular`);
  const plain = await app.call("GET", `/dishes?${kq}`);
  check(!list(sorted.data).some((dish) => dish.dishId === slotDishId), "dishes of a hidden category are not listed (sorted list)", "", "6");
  check(sorted.data?.total === plain.data?.total, "/dishes total is the same with or without sort", `${sorted.data?.total} vs ${plain.data?.total}`, "6");
  const hiddenDetail = await app.call("GET", `/menu/items/${slotDishId}?${kq}`);
  check(hiddenDetail.status === 404, "a hidden category's dish has no detail page", String(hiddenDetail.status), "6");

  // ------------------------------------------------------------ filters & params
  group("3. Filters and parameters");
  const filters = await app.call("GET", `/dishes/filters?${kq}`);
  const sorts = (filters.data?.sort || []).map((item) => item.value);
  const rejected = [];
  for (const sort of sorts) {
    const res = await app.call("GET", `/dishes?${kq}&sort=${sort}`);
    if (res.status !== 200) rejected.push(`${sort}:${res.status}`);
  }
  check(sorts.length && !rejected.length, "every sort the filter screen offers is accepted", rejected.join(" ") || sorts.join(","), "7");
  check(sorts.includes("prep_time"), "filter screen offers prep-time sort", "", "7");
  const priced = await app.call("GET", `/dishes?${kq}&minPricePaise=20000&maxPricePaise=30000`);
  check(priced.status === 200 && list(priced.data).length && list(priced.data).every((dish) => dish.pricePaise >= 20000 && dish.pricePaise <= 30000), "price range filter works", `${list(priced.data).length} dishes`, "7");
  const multi = await app.call("GET", `/dishes?${kq}&cuisine=Hyderabadi,Fusion`);
  check(multi.status === 200 && new Set(list(multi.data).map((dish) => dish.cuisine)).size === 2, "several cuisines at once", [...new Set(list(multi.data).map((dish) => dish.cuisine))].join(","), "7");
  for (const [query, label] of [["categoryId=notanid", "bad categoryId"], ["slot=midnight", "unknown slot"], ["q[$ne]=x", "q as an object"], [`cuisine=${"x".repeat(200)}`, "200-char cuisine"], ["availableOnly=maybe", "availableOnly=maybe"]]) {
    const res = await app.call("GET", `/dishes?${kq}&${query}`);
    check(res.status === 422, `${label} is rejected`, String(res.status), "19");
  }
  const menu = await app.call("GET", `/menu?${kq}`);
  check(menu.data && !("dishes" in menu.data && menu.data.categories?.[0]?.dishes), "/menu sends each dish once", "", "18");

  // ------------------------------------------------------------ contract
  group("4. App contract");
  const bowl = list(plain.data).find((dish) => dish.name === "Butter Chicken Bowl");
  const detail = await app.call("GET", `/menu/items/${bowl?.dishId}?${kq}`);
  check(detail.data?.customizationGroups?.every((g) => typeof g.required === "boolean"), "option groups say whether they are required", JSON.stringify(detail.data?.customizationGroups?.map((g) => g.required)), "12");
  check(detail.data && typeof detail.data.isFavorite === "boolean", "dish detail says whether it is a favourite (heart)", String(detail.data?.isFavorite), "14");
  const combos = await app.call("GET", `/combos?${kq}`);
  const combo = list(combos.data)[0];
  check(combo?.items?.every((item) => item.imageUrl !== undefined && Number.isInteger(item.pricePaise)), "combo items carry image and price", "", "15");
  check(combo && Number.isInteger(combo.savingsPaise), "combos carry the saving (Save ₹X)", String(combo?.savingsPaise), "15");
  check(combo && !("approvalStatus" in combo) && !("isActive" in combo), "combos carry no internal fields", "", "21");
  const comboOne = await app.call("GET", `/combos/${combo?.comboId}?${kq}`);
  check(comboOne.status === 200 && comboOne.data?.comboId === combo?.comboId, "single combo endpoint", String(comboOne.status), "15");
  const recsUnknown = await app.call("GET", `/menu/items/000000000000000000000000/recommendations?${kq}`);
  check(recsUnknown.status === 404, "recommendations for an unknown dish is 404", String(recsUnknown.status), "16");
  const appRoute = await app.call("GET", `/kitchens/${kitchenId}/menu`);
  check(appRoute.status === 200, "the app's menu route /kitchens/:id/menu works", String(appRoute.status), "17");

  // ------------------------------------------------------------ favourites
  group("5. Favourites");
  const mutton = list(plain.data).find((dish) => dish.name === "Mutton Biryani");
  cleanups.push(() => app.call("DELETE", `/users/me/favorites/${mutton?.dishId}`));
  const wasFavorite = list((await app.call("GET", "/users/me/favorites")).data).some((dish) => dish.dishId === mutton?.dishId);
  await app.call("DELETE", `/users/me/favorites/${mutton?.dishId}`);
  // Runs last (cleanups run in reverse): put the seeded favourite back.
  if (wasFavorite) cleanups.unshift(() => app.call("POST", "/users/me/favorites", { dishId: mutton?.dishId }));
  const add1 = await app.call("POST", "/users/me/favorites", { dishId: mutton?.dishId });
  const add2 = await app.call("POST", "/users/me/favorites", { dishId: mutton?.dishId });
  check(add1.status === 201 && add2.status === 200, "adding a favourite twice is not a second create", `${add1.status}/${add2.status}`, "20");
  const favs = await app.call("GET", "/users/me/favorites");
  const fav = list(favs.data).find((dish) => dish.dishId === mutton?.dishId);
  check(fav && "orderableHere" in fav && fav.kitchenName, "favourites say if they can be ordered here, and from which kitchen", JSON.stringify({ orderableHere: fav?.orderableHere, kitchenName: fav?.kitchenName }), "14");
  if (otherDish) {
    await app.call("POST", "/users/me/favorites", { dishId: String(otherDish._id) });
    cleanups.push(() => app.call("DELETE", `/users/me/favorites/${otherDish._id}`));
    const favs2 = await app.call("GET", "/users/me/favorites");
    const other = list(favs2.data).find((dish) => dish.dishId === String(otherDish._id));
    check(other && other.orderableHere === false, "a favourite from a kitchen that does not deliver here is flagged", String(other?.orderableHere), "14");
  }

  // ------------------------------------------------------------ search
  group("6. Search");
  const hindi = await app.call("GET", `/search?q=${encodeURIComponent("पनीर")}&${kq}`);
  check(hindi.status === 200 && (hindi.data?.dishes || []).every((dish) => /paneer|पनीर/i.test(`${dish.name} ${(dish.tags || []).join(" ")}`)), "Hindi text is not split into junk matches", `${(hindi.data?.dishes || []).length} dishes`, "9");
  const typo = await app.call("GET", `/search?q=briyani&${kq}`);
  check((typo.data?.dishes || []).some((dish) => /biryani/i.test(dish.name)), "small typo still finds the dish ('briyani')", `${(typo.data?.dishes || []).length} dishes`, "9");
  const nothing = await app.call("GET", `/search?q=sushi&${kq}`);
  check(nothing.data && Array.isArray(nothing.data.suggestions) && nothing.data.suggestions.length, "zero results come with suggestions", JSON.stringify(nothing.data?.suggestions), "11");
  const geo = await app.call("GET", `/search?q=biryani&latitude=12.942795&longitude=77.624478`);
  check(geo.status === 200, "search accepts latitude/longitude like the menu", String(geo.status), "11");
  // Start from a clean recent list (older runs may have saved prefixes).
  await app.call("DELETE", "/search/recent");
  for (const q of ["p", "pa", "pan", "pane", "paneer"]) await app.call("GET", `/search?q=${q}&${kq}`);
  const recent = await app.call("GET", "/search/recent");
  const recentQueries = (recent.data || []).map((item) => item.query);
  check(!["p", "pa", "pan", "pane"].some((q) => recentQueries.includes(q)), "typing a search does not save every prefix", recentQueries.slice(0, 5).join(", "), "10");
  const clickUnknown = await app.call("POST", "/search/000000000000000000000000/click", { dishId: bowl?.dishId });
  check(clickUnknown.status === 404, "click on an unknown search is 404", String(clickUnknown.status), "23");
}

try {
  await main();
} catch (err) {
  record(false, "smoke test crashed", err.message);
} finally {
  for (const undo of cleanups.reverse()) await undo().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  const refs = [...new Set(failed.map((r) => r.ref).filter(Boolean))].sort((a, b) => a - b);
  if (refs.length) console.log(`Open issues (scan #): ${refs.join(", ")}`);
  process.exit(failed.length ? 1 : 0);
}
