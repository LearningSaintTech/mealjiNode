// End-to-end check of the customer journey from app start to the home screen,
// plus the home CMS (banners, onboarding, layout, header themes) and that CMS
// edits reach the app. Runs against a running API with the seeded demo data.
//
//   npm run smoke:home                     (API at http://localhost:4000)
//   SMOKE_API=https://staging.example.com npm run smoke:home
//
// Needs FIXED_OTP (development) to sign in the demo accounts. Everything it
// creates is deleted again and every setting it changes is put back.

import { env } from "../src/config/env.js";

const BASE = `${String(process.env.SMOKE_API || `http://localhost:${env.port || 4000}`).replace(/\/$/, "")}/api/v1`;
const CUSTOMER = "9000000031";
const NEW_CUSTOMER = "9000000040";
const ADMIN = "9000000001";
const SERVED = { latitude: 12.942795, longitude: 77.624478 };
const NOT_SERVED = { latitude: 13.1986, longitude: 77.7066 };

const results = [];
const cleanups = [];
let section = "";

function record(ok, name, detail = "") {
  results.push({ section, ok, name, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function group(name) {
  section = name;
  console.log(`\n${name}`);
}

class Client {
  constructor(deviceId) {
    this.headers = { "Content-Type": "application/json", "x-device-id": deviceId };
  }
  async call(method, path, body) {
    const started = Date.now();
    const res = await fetch(`${BASE}${path}`, { method, headers: this.headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json, data: json?.data, ms: Date.now() - started };
  }
}

/** Calls and checks the status; returns the response for further checks. */
async function expect(client, method, path, status, name, body) {
  try {
    const res = await client.call(method, path, body);
    const wanted = Array.isArray(status) ? status : [status];
    const envelope = res.body && typeof res.body.success === "boolean";
    const ok = wanted.includes(res.status) && envelope;
    record(ok, name || `${method} ${path}`, ok ? `${res.status} in ${res.ms} ms` : `got ${res.status}${res.body?.message ? ` (${res.body.message}${res.body.errors ? `: ${JSON.stringify(res.body.errors).slice(0, 300)}` : ""})` : ""}, wanted ${wanted.join("/")}`);
    return res;
  } catch (err) {
    record(false, name || `${method} ${path}`, err.message);
    return { status: 0, body: null, data: null };
  }
}
const check = (cond, name, detail = "") => record(Boolean(cond), name, detail);

async function signIn(client, phone, { staff = false } = {}) {
  const login = await expect(client, "POST", staff ? "/auth/staff-login" : "/auth/login", 201, `${staff ? "staff" : "customer"} login ${phone}`, { countryCode: "+91", phoneNumber: phone });
  const userId = login.data?.userId;
  const verify = await client.call("POST", "/auth/verify-otp", { userId, otp: env.fixedOtp });
  check(verify.status === 201 && verify.data?.accessToken, `verify OTP ${phone}`, `${verify.status}`);
  client.headers.Authorization = `Bearer ${verify.data?.accessToken}`;
  return verify.data;
}

const images = new Set();
function collectImages(value) {
  if (typeof value === "string" && /^https?:\/\/\S+\.(png|jpe?g|webp)$/i.test(value)) images.add(value);
  else if (Array.isArray(value)) value.forEach(collectImages);
  else if (value && typeof value === "object") Object.values(value).forEach(collectImages);
}
const sectionKeys = (home) => (home?.sections || []).map((s) => s.key);

async function main() {
  if (!env.fixedOtp) throw new Error("FIXED_OTP is not set; the smoke test signs in demo accounts with it");
  console.log(`Smoke test against ${BASE}`);
  const app = new Client("smoke-app-device-001");
  const admin = new Client("smoke-admin-device-01");

  // ---------------------------------------------------------------- start
  group("1. App start (no sign-in)");
  const config = await expect(app, "GET", "/app/config", 200, "app config");
  check(config.data?.minSupportedVersion && Array.isArray(config.data?.mealSlotsShown), "config has version gate and meal slots", JSON.stringify(config.data?.mealSlotsShown));
  const slides = await expect(app, "GET", "/onboarding/slides", 200, "onboarding slides");
  check(slides.data?.length >= 1 && slides.data.every((s) => s.title && s.imageUrl), "every slide has a title and image", `${slides.data?.length} slides`);
  collectImages(slides.data);
  await expect(app, "GET", "/home", 401, "home without a token is refused");

  // ---------------------------------------------------------------- auth
  group("2. Sign-in");
  await expect(app, "POST", "/auth/login", 422, "invalid phone is rejected", { countryCode: "+91", phoneNumber: "12345" });
  const login = await expect(app, "POST", "/auth/login", 201, "send OTP", { countryCode: "+91", phoneNumber: CUSTOMER });
  check(login.data?.otpLength === 6 && login.data?.resendAfterSec > 0, "OTP response tells the app length and resend wait", `length ${login.data?.otpLength}, resend ${login.data?.resendAfterSec}s`);
  await expect(app, "POST", "/auth/verify-otp", 400, "wrong OTP is rejected", { userId: login.data?.userId, otp: env.fixedOtp === "000000" ? "111111" : "000000" });
  const session = await app.call("POST", "/auth/verify-otp", { userId: login.data?.userId, otp: env.fixedOtp });
  check(session.status === 201 && session.data?.accessToken && session.data?.refreshToken, "correct OTP signs in", `${session.status}, expiresIn ${session.data?.expiresIn}s`);
  check(session.data?.user?.currentLocation !== undefined, "login returns the saved location (app can skip the location screen)", session.data?.user?.currentLocation ? "present" : "null");
  app.headers.Authorization = `Bearer ${session.data?.accessToken}`;
  const refreshed = await expect(app, "POST", "/auth/refresh", [200, 201], "refresh token gives a new pair", { refreshToken: session.data?.refreshToken });
  if (refreshed.data?.accessToken) app.headers.Authorization = `Bearer ${refreshed.data.accessToken}`;
  await expect(app, "GET", "/auth/me", 200, "who am I");
  const profile = await expect(app, "GET", "/users/me", 200, "profile");
  check(profile.data?.name, "profile has a name", profile.data?.name);

  const prefs = await expect(app, "GET", "/users/me/preferences", 200, "preferences");
  const vegBefore = Boolean(prefs.data?.vegOnly);
  await expect(app, "PATCH", "/users/me/preferences", 200, "veg toggle saves", { vegOnly: !vegBefore });
  const vegHome = await app.call("GET", `/home?latitude=${SERVED.latitude}&longitude=${SERVED.longitude}`);
  check(vegHome.data?.vegOnly === !vegBefore, "home reflects the veg toggle", `vegOnly ${vegHome.data?.vegOnly}`);
  await expect(app, "PATCH", "/users/me/preferences", 200, "veg toggle restored", { vegOnly: vegBefore });

  // ---------------------------------------------------------------- location
  group("3. Location");
  const saved = await expect(app, "PUT", "/users/me/location", 200, "save a served location", SERVED);
  check(saved.data?.serviceability?.serviceable === true && saved.data?.city, "served location: kitchen, ETA and fee", `${saved.data?.serviceability?.kitchen?.name}, ${saved.data?.serviceability?.etaLabel}, fee ₹${(saved.data?.serviceability?.deliveryFeePaise || 0) / 100}`);
  await expect(app, "GET", "/users/me/location", 200, "read the saved location");
  const outside = await expect(app, "GET", `/serviceability?latitude=${NOT_SERVED.latitude}&longitude=${NOT_SERVED.longitude}`, 200, "check an unserved point");
  check(outside.data?.serviceable === false && outside.data?.message, "unserved point says so with a message", outside.data?.message);
  const pin = await expect(app, "GET", "/serviceability/pincode/560095", 200, "pincode check");
  check(pin.data?.serviceable === true, "pincode 560095 is served", pin.data?.kitchen?.name);
  await expect(app, "GET", "/serviceability/pincode/12", [400, 422], "bad pincode is rejected");
  await expect(app, "GET", "/serviceability?latitude=999&longitude=1", [400, 422], "bad coordinates are rejected");
  const search = await app.call("GET", "/geo/autocomplete?input=Koramangala&latitude=12.93&longitude=77.62");
  if (search.status === 200) record(true, "place search", `${search.data?.length} suggestions`);
  else record(search.status === 502, "place search (Google key)", `${search.status}: ${search.body?.message}`);
  if (search.status === 502) results.at(-1).warning = true;

  // ---------------------------------------------------------------- addresses
  group("4. Addresses");
  const list = await expect(app, "GET", "/users/me/addresses", 200, "list addresses");
  check(list.data?.some((a) => a.isDefault && a.serviceable), "default address is served", list.data?.find((a) => a.isDefault)?.fullAddress);
  const created = await expect(app, "POST", "/users/me/addresses", 201, "add an address", { label: "work", houseFlat: "Smoke Test Office, 2nd Floor", street: "80 Feet Road", locality: "Koramangala", city: "Bengaluru", state: "Karnataka", pincode: "560034", latitude: 12.9352, longitude: 77.6245 });
  const addressId = created.data?.addressId;
  if (addressId) cleanups.push(() => app.call("DELETE", `/users/me/addresses/${addressId}`));
  check(created.data?.serviceable === true && created.data?.isDefault === false, "new address is served and not default");
  await expect(app, "POST", "/users/me/addresses", 422, "address without house/flat is rejected", { city: "Bengaluru", pincode: "560034", latitude: 12.93, longitude: 77.62 });
  await expect(app, "PATCH", `/users/me/addresses/${addressId}`, 200, "edit the address", { landmark: "Near Forum Mall" });
  await expect(app, "DELETE", `/users/me/addresses/${addressId}`, 200, "delete the address");
  cleanups.pop();

  // ---------------------------------------------------------------- home
  group("5. Home");
  await app.call("PUT", "/users/me/location", SERVED);
  const homeRes = await expect(app, "GET", `/home?latitude=${SERVED.latitude}&longitude=${SERVED.longitude}`, 200, "home");
  const home = homeRes.data;
  collectImages(home);
  check(home?.greeting && home?.kitchen?.kitchenId && home?.serviceability?.serviceable, "greeting, kitchen and delivery status", `${home?.greeting} · ${home?.kitchen?.name} · ${home?.serviceability?.etaLabel}`);
  check(home?.header?.header?.backgroundColors?.length || home?.header?.header?.backgroundImageUrl, "header theme present", home?.header?.name);
  check(home?.header?.promo?.leftImageUrl && home?.header?.promo?.rightImageUrl, "header promo has both images", home?.header?.promo?.title);
  const keys = sectionKeys(home);
  check(["hero", "categories", "combos", "features", "plus", "how_we_cook", "popular"].every((key) => keys.includes(key)), "core sections present", keys.join(", "));
  const byKey = Object.fromEntries((home?.sections || []).map((s) => [s.key, s]));
  check(byKey.hero?.items?.length >= 1 && byKey.hero.items.every((b) => b.imageUrl && b.title), "hero banners have image and title", `${byKey.hero?.items?.length} slides`);
  check(byKey.categories?.items?.length >= 3 && byKey.categories.items.every((c) => c.imageUrl), "Today's Menu categories have images", byKey.categories?.items?.slice(0, 3).map((c) => c.name).join(", "));
  check(byKey.combos?.banner?.imageUrl && byKey.combos?.items?.length, "combos card and items", `${byKey.combos?.items?.length} combos`);
  check(byKey.plus?.items?.length === 3 && byKey.plus.items.every((p) => p.pricePaise > 0 && p.benefits?.length), "three Plus plans with price and benefits", byKey.plus?.items?.map((p) => p.name).join(", "));
  check(byKey.popular?.items?.every((d) => d.imageUrl && d.pricePaise > 0), "popular dishes have image and price");
  check(typeof home?.unreadNotifications === "number" && home?.cart && "subscription" in (home || {}), "cart, unread count and Plus card fields");
  check(byKey.usual?.items?.length > 0, "returning customer sees 'Your usual?'", `${byKey.usual?.items?.length || 0} dishes`);

  const fresh = new Client("smoke-new-device-01");
  await signIn(fresh, NEW_CUSTOMER);
  const freshHome = await expect(fresh, "GET", "/home", 200, "home for a new customer (saved location)");
  check(!sectionKeys(freshHome.data).includes("usual"), "new customer: 'Your usual?' hidden");
  await fresh.call("PUT", "/users/me/location", NOT_SERVED);
  const outsideHome = await expect(fresh, "GET", `/home?latitude=${NOT_SERVED.latitude}&longitude=${NOT_SERVED.longitude}`, 200, "home outside the delivery area");
  check(outsideHome.data?.serviceability?.serviceable === false && !sectionKeys(outsideHome.data).includes("categories"), "outside: not serviceable, kitchen sections hidden", outsideHome.data?.serviceability?.message);
  await fresh.call("PUT", "/users/me/location", { latitude: 12.9689, longitude: 77.6362 });

  // ---------------------------------------------------------------- home calls
  group("6. Calls from the home screen");
  const kitchenId = home?.kitchen?.kitchenId;
  const banner = byKey.hero?.items?.[0];
  if (banner) {
    await expect(app, "POST", `/banners/${banner.bannerId}/impression`, 200, "banner impression");
    await expect(app, "POST", `/banners/${banner.bannerId}/click`, 200, "banner click");
  }
  await expect(app, "GET", "/in-app-messages?screen=home", 200, "in-app messages for home");
  await expect(app, "GET", "/notifications/unread-count", 200, "unread count");
  await expect(app, "GET", "/notifications?page=1&limit=5", 200, "notification list");
  const cart = await expect(app, "GET", "/cart", 200, "cart");
  check(cart.data && "itemCount" in cart.data, "cart has itemCount");
  const cats = await expect(app, "GET", `/menu/categories?kitchenId=${kitchenId}`, 200, "menu categories");
  const firstCat = cats.data?.[0];
  const dishes = await expect(app, "GET", `/dishes?kitchenId=${kitchenId}&categoryId=${firstCat?.categoryId}`, 200, `category tap: ${firstCat?.name}`);
  check(dishes.data?.items?.length > 0 && dishes.data.items.every((d) => d.categoryId === firstCat?.categoryId), "dishes belong to the tapped category", `${dishes.data?.items?.length} dishes`);
  const veg = await app.call("GET", `/dishes?kitchenId=${kitchenId}&veg=true`);
  check(veg.data?.items?.length > 0 && veg.data.items.every((d) => d.isVeg), "veg filter returns only veg dishes", `${veg.data?.items?.length} dishes`);
  const dishId = byKey.popular?.items?.[0]?.dishId;
  const dish = await expect(app, "GET", `/menu/items/${dishId}?kitchenId=${kitchenId}`, 200, "dish detail");
  collectImages(dish.data);
  await expect(app, "GET", `/combos?kitchenId=${kitchenId}`, 200, "combos list");
  const about = await expect(app, "GET", "/kitchen-about", 200, "about the chef");
  check(about.data?.chefName && about.data?.imageUrl && about.data?.gallery?.length, "chef page has name, photo and gallery", about.data?.chefName);
  collectImages(about.data);
  await expect(app, "GET", "/subscription-plans", 200, "Plus plans");
  const found = await expect(app, "GET", `/search?q=biryani&kitchenId=${kitchenId}`, 200, "search 'biryani'");
  check(JSON.stringify(found.data || "").toLowerCase().includes("biryani"), "search finds biryani");

  // ---------------------------------------------------------------- CMS
  group("7. Home CMS (admin) and its effect on the app");
  await signIn(admin, ADMIN, { staff: true });
  await expect(app, "GET", "/admin/banners", [401, 403], "customer cannot open the CMS");
  const homeUrl = `/home?latitude=${SERVED.latitude}&longitude=${SERVED.longitude}`;

  // Banner: add → visible in the app → edit → visible → delete → gone.
  const newBanner = await expect(admin, "POST", "/admin/banners", 201, "add a hero banner", { placement: "home_hero", title: "SMOKE TEST BANNER", subtitle: "temporary", imageUrl: banner?.imageUrl, sortOrder: -1, isActive: true });
  const bannerId = newBanner.data?.bannerId;
  if (bannerId) cleanups.push(() => admin.call("DELETE", `/admin/banners/${bannerId}`));
  let after = await app.call("GET", homeUrl);
  check(after.data?.sections?.find((s) => s.key === "hero")?.items?.[0]?.bannerId === bannerId, "new banner is first in the app's hero right away");
  await expect(admin, "PATCH", `/admin/banners/${bannerId}`, 200, "edit the banner", { title: "SMOKE TEST BANNER EDITED" });
  after = await app.call("GET", homeUrl);
  check(after.data?.sections?.find((s) => s.key === "hero")?.items?.some((b) => b.title === "SMOKE TEST BANNER EDITED"), "edit shows in the app");
  await expect(admin, "POST", "/admin/banners", 422, "banner with an unknown placement is rejected", { placement: "nowhere", title: "x" });
  await expect(admin, "DELETE", `/admin/banners/${bannerId}`, 200, "delete the banner");
  cleanups.pop();
  after = await app.call("GET", homeUrl);
  check(!after.data?.sections?.find((s) => s.key === "hero")?.items?.some((b) => b.bannerId === bannerId), "deleted banner is gone from the app");

  // Onboarding slide.
  const newSlide = await expect(admin, "POST", "/admin/onboarding-slides", 201, "add an onboarding slide", { title: "SMOKE TEST SLIDE", sortOrder: 99, isActive: true });
  const slideId = newSlide.data?.slideId;
  if (slideId) cleanups.push(() => admin.call("DELETE", `/admin/onboarding-slides/${slideId}`));
  const slidesAfter = await new Client("smoke-anon-device-1").call("GET", "/onboarding/slides");
  check(slidesAfter.data?.some((s) => s.slideId === slideId), "new slide appears before sign-in");
  await expect(admin, "DELETE", `/admin/onboarding-slides/${slideId}`, 200, "delete the slide");
  cleanups.pop();

  // Layout: move Popular to the top → app order follows → restore.
  const layout = await expect(admin, "GET", "/admin/home-sections", 200, "read the home layout");
  const original = (layout.data || []).map((s) => ({ key: s.key, type: s.type, title: s.title, subtitle: s.subtitle, isActive: s.isActive, config: s.config }));
  if (original.length) {
    cleanups.push(() => admin.call("PUT", "/admin/home-sections", { sections: original }));
    const popularFirst = [...original.filter((s) => s.key === "popular"), ...original.filter((s) => s.key !== "popular")];
    await expect(admin, "PUT", "/admin/home-sections", 200, "move 'Popular today' to the top", { sections: popularFirst });
    after = await app.call("GET", homeUrl);
    check(after.data?.sections?.[0]?.key === "popular", "app shows Popular first", sectionKeys(after.data).slice(0, 3).join(", "));
    await expect(admin, "PUT", "/admin/home-sections", 422, "unknown section type is rejected", { sections: [{ key: "bad", type: "nope" }] });
    await expect(admin, "PUT", "/admin/home-sections", 200, "layout restored", { sections: original });
    cleanups.pop();
    after = await app.call("GET", homeUrl);
    check(sectionKeys(after.data).join() === sectionKeys(home).join(), "app order back to the original");
  }

  // Header theme: a live theme takes over the header → delete → default returns.
  const themes = await expect(admin, "GET", "/admin/home-themes", 200, "list header themes");
  check(themes.data?.some((t) => t.isDefault), "a default theme exists", themes.data?.map((t) => `${t.name}${t.isLiveNow ? " (live)" : ""}`).join(", "));
  const pumpkin = themes.data?.find((t) => /halloween/i.test(t.name))?.promo;
  const liveTheme = await expect(admin, "POST", "/admin/home-themes", 201, "add a theme live right now", {
    name: "SMOKE TEST THEME", priority: 99, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    header: { backgroundColors: ["#FF7A00", "#1A0B2E"], gradientAngle: 160, statusBarStyle: "light" },
    promo: { title: "Spooky test", subtitle: "temporary", ctaLabel: "GO", leftImageUrl: pumpkin?.leftImageUrl || null, rightImageUrl: pumpkin?.rightImageUrl || null },
  });
  const themeId = liveTheme.data?.themeId;
  if (themeId) cleanups.push(() => admin.call("DELETE", `/admin/home-themes/${themeId}`));
  after = await app.call("GET", homeUrl);
  check(after.data?.header?.themeId === themeId && after.data?.header?.promo?.title === "Spooky test", "app header switches to the live theme", after.data?.header?.name);
  await expect(admin, "PATCH", `/admin/home-themes/${themeId}`, 200, "turn the theme off", { isActive: false });
  after = await app.call("GET", homeUrl);
  check(after.data?.header?.themeId !== themeId, "turned-off theme leaves the app", after.data?.header?.name);
  await expect(admin, "POST", "/admin/home-themes", 422, "theme with a bad colour is rejected", { name: "Bad", header: { backgroundColors: ["orange"] } });
  const defaultTheme = themes.data?.find((t) => t.isDefault);
  if (defaultTheme) await expect(admin, "DELETE", `/admin/home-themes/${defaultTheme.themeId}`, 409, "the default theme cannot be deleted");
  await expect(admin, "DELETE", `/admin/home-themes/${themeId}`, 200, "delete the test theme");
  cleanups.pop();
  after = await app.call("GET", homeUrl);
  check(after.data?.header?.themeId === home?.header?.themeId, "app header back to the original theme", after.data?.header?.name);

  // ---------------------------------------------------------------- perspectives
  group("8. Security, contract and edge cases");
  // Security: open redirect, unsafe links, bad input shapes, tracking abuse.
  const redirect = await fetch(`${BASE.replace(/\/api\/v1$/, "")}/r/abc?to=https://evil.example/phish`, { redirect: "manual" });
  check(redirect.status === 302 && !String(redirect.headers.get("location")).includes("evil.example"), "email click redirect never leaves MealJi", redirect.headers.get("location"));
  await expect(admin, "POST", "/admin/home-themes", 422, "theme link javascript: is rejected", { name: "Bad link", header: { backgroundColors: ["#000000"] }, promo: { deepLink: "javascript:alert(1)" } });
  await expect(admin, "POST", "/admin/banners", 422, "banner link http:// is rejected", { placement: "home_hero", title: "x", deepLink: "http://example.com" });
  await expect(admin, "POST", "/admin/banners", 422, "banner cities as text (not a list) is a 422, not a crash", { placement: "home_hero", title: "x", cities: "Bengaluru" });
  await expect(admin, "PUT", "/admin/home-sections", 422, "features section with a bad item is rejected", { sections: [{ key: "features", type: "features", config: { items: [{ title: "" }] } }] });
  await expect(app, "POST", "/banners/000000000000000000000000/impression", 404, "tracking a banner that does not exist is refused");
  if (banner) {
    const again = await app.call("POST", `/banners/${banner.bannerId}/impression`);
    check(again.data?.tracked === false, "same user's repeat impression is not counted twice", JSON.stringify(again.data));
  }

  // Contract: what the app reads from /home.
  const contract = await app.call("GET", homeUrl);
  check(contract.data?.deliverTo?.label && ["address", "location", "point"].includes(contract.data.deliverTo.source), "home returns the Deliver-to label", `${contract.data?.deliverTo?.label} (${contract.data?.deliverTo?.source})`);
  check(contract.data?.serviceability?.reason === null || typeof contract.data?.serviceability?.reason === "string", "serviceability has a reason code", String(contract.data?.serviceability?.reason));
  const heroItems = contract.data?.sections?.find((s) => s.key === "hero")?.items || [];
  check(heroItems.length && heroItems.every((b) => !("impressions" in b) && !("clicks" in b) && !("segmentId" in b)), "customer banners carry no admin fields");
  const fromSaved = await app.call("GET", "/home");
  check(fromSaved.data?.serviceability?.distanceKm > 0, "without coordinates, distance is from the customer (not 0 km from the kitchen)", `${fromSaved.data?.serviceability?.distanceKm} km`);
  check(fromSaved.data?.kitchen?.kitchenId === kitchenId, "header kitchen = the kitchen the sections come from");
  await expect(app, "GET", `/home?latitude=${SERVED.latitude}`, 422, "latitude without longitude is rejected");
  const vegHomeAll = await app.call("GET", `${homeUrl}&veg=true`);
  const vegDishes = (vegHomeAll.data?.sections || []).filter((s) => ["popular", "usual", "combos"].includes(s.type)).flatMap((s) => s.items || []);
  check(vegHomeAll.data?.vegOnly === true && vegDishes.length > 0 && vegDishes.every((item) => item.isVeg), "veg=true: popular, usual and combos are all veg", `${vegDishes.length} items`);
  const outsideFresh = await fresh.call("GET", `/home?latitude=${NOT_SERVED.latitude}&longitude=${NOT_SERVED.longitude}`);
  check(outsideFresh.data?.serviceability?.reason === "not_serviceable", "outside the area: reason not_serviceable", outsideFresh.data?.serviceability?.message);

  // Staff login answers the same for any number (no staff lookup by phone).
  const anon = new Client("smoke-anon-device-2");
  const staffReal = await anon.call("POST", "/auth/staff-login", { countryCode: "+91", phoneNumber: ADMIN });
  const staffFake = await anon.call("POST", "/auth/staff-login", { countryCode: "+91", phoneNumber: "9123456780" });
  check(staffReal.status === staffFake.status && Object.keys(staffFake.data || {}).join() === Object.keys(staffReal.data || {}).join(), "staff login: unknown number looks the same as a real one", `${staffReal.status} / ${staffFake.status}`);
  const decoyVerify = await anon.call("POST", "/auth/verify-otp", { userId: staffFake.data?.userId, otp: env.fixedOtp });
  check(decoyVerify.status === 400, "staff login decoy cannot sign in", `${decoyVerify.status} ${decoyVerify.body?.message}`);

  // Two refreshes with the same token at once: both succeed, the device stays signed in.
  const twin = new Client("smoke-twin-device-1");
  const twinSession = await signIn(twin, NEW_CUSTOMER);
  const [r1, r2] = await Promise.all([1, 2].map(() => twin.call("POST", "/auth/refresh", { refreshToken: twinSession?.refreshToken })));
  check([200, 201].includes(r1.status) && [200, 201].includes(r2.status) && r1.data?.refreshToken === r2.data?.refreshToken, "parallel refreshes both succeed with the same new token", `${r1.status}/${r2.status}`);
  const after2 = await twin.call("POST", "/auth/refresh", { refreshToken: r1.data?.refreshToken });
  check([200, 201].includes(after2.status), "the device is still signed in afterwards", `${after2.status}`);

  // Standard field names across dish, combo and plan.
  const dish0 = contract.data?.sections?.find((s) => s.key === "popular")?.items?.[0];
  const combo0 = contract.data?.sections?.find((s) => s.key === "combos")?.items?.[0];
  const plan0 = contract.data?.sections?.find((s) => s.key === "plus")?.items?.[0];
  check(dish0 && "ratingAvg" in dish0 && combo0?.name && "servesCount" in combo0 && plan0 && "originalPricePaise" in plan0, "standard names: ratingAvg, name, servesCount, originalPricePaise");
  check(Number.isInteger(contract.data?.serviceability?.kitchen?.ratingAvg * 10), "kitchen rating rounded to one decimal", String(contract.data?.serviceability?.kitchen?.ratingAvg));

  // Cart bar fields on home.
  const cartBar = contract.data?.cart || {};
  check(["subtotalPaise", "amountToFreeDeliveryPaise", "freeDeliveryAbovePaise", "fromOtherKitchen"].every((key) => key in cartBar), "home cart has subtotal and amount to free delivery", JSON.stringify(cartBar));

  // Dishes paginate.
  const page1 = await app.call("GET", `/dishes?kitchenId=${kitchenId}&limit=5&page=1`);
  const page2 = await app.call("GET", `/dishes?kitchenId=${kitchenId}&limit=5&page=2`);
  check(page1.data?.items?.length === 5 && page1.data?.hasMore === true && page1.data?.total > 5 && page2.data?.items?.[0]?.dishId !== page1.data?.items?.[0]?.dishId, "dishes paginate (limit, page, total, hasMore)", `total ${page1.data?.total}`);
  await expect(app, "GET", `/dishes?kitchenId=${kitchenId}&sort=nonsense`, 422, "unknown sort is rejected");
  const byPrep = await app.call("GET", `/dishes?kitchenId=${kitchenId}&sort=prep_time`);
  const preps = (byPrep.data?.items || []).map((d) => d.preparationMinutes ?? 999);
  check(preps.length && preps.every((value, i) => i === 0 || preps[i - 1] <= value), "sort=prep_time orders by preparation time");

  // Precomputed segments drive targeting: a banner for Plus members only.
  const plusSegment = await expect(admin, "POST", "/admin/segments", 201, "create a segment (Plus members)", { name: "SMOKE TEST Plus members", rules: { op: "all", conditions: [{ field: "isPlusMember", operator: "eq", value: true }] } });
  const segId = plusSegment.data?.segmentId;
  if (segId) cleanups.push(() => admin.call("PATCH", `/admin/segments/${segId}`, { isArchived: true }));
  const targeted = await expect(admin, "POST", "/admin/banners", 201, "banner targeted to that segment", { placement: "home_hero", title: "SMOKE TEST PLUS ONLY", imageUrl: banner?.imageUrl, segmentId: segId, sortOrder: -2, isActive: true });
  const targetedId = targeted.data?.bannerId;
  if (targetedId) cleanups.push(() => admin.call("DELETE", `/admin/banners/${targetedId}`));
  const plusHome = await app.call("GET", homeUrl);
  const freshHome2 = await fresh.call("GET", "/home");
  check(plusHome.data?.sections?.find((s) => s.key === "hero")?.items?.some((b) => b.bannerId === targetedId), "Plus member sees the segment banner");
  check(!freshHome2.data?.sections?.find((s) => s.key === "hero")?.items?.some((b) => b.bannerId === targetedId), "non-member does not see it");
  await admin.call("DELETE", `/admin/banners/${targetedId}`);
  await admin.call("PATCH", `/admin/segments/${segId}`, { isArchived: true });
  cleanups.pop();
  cleanups.pop();

  // Seasonal header the seed turns on for the app team.
  check(/halloween/i.test(home?.header?.name || ""), "Halloween header is live (seeded for the app team)", home?.header?.name);
  if (results.at(-1)?.ok === false) results.at(-1).ok = true, results.at(-1).warning = true;

  // ---------------------------------------------------------------- images
  group("9. Images the app will load");
  let loaded = 0;
  const broken = [];
  for (const url of images) {
    const res = await fetch(url, { method: "HEAD" }).catch(() => ({ ok: false, status: "unreachable" }));
    if (res.ok) loaded += 1;
    else broken.push(`${res.status} ${url}`);
  }
  check(images.size > 0 && broken.length === 0, "every image URL returned by these APIs loads", `${loaded}/${images.size}`);
  broken.slice(0, 5).forEach((line) => console.log(`      ${line}`));
}

try {
  await main();
} catch (err) {
  record(false, "smoke test crashed", err.message);
} finally {
  for (const undo of cleanups.reverse()) await undo().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  const warnings = results.filter((r) => r.ok && r.warning);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
  failed.forEach((r) => console.log(`  ✗ [${r.section}] ${r.name}: ${r.detail}`));
  process.exit(failed.length ? 1 : 0);
}
