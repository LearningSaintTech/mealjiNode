// Step 05 · Home — Home screen (header, sections, Filters sheet, cart bar) and About chef.
import { Client, createSuite, DEMO, headOk, newCustomer, POINTS } from "./harness.js";

const APP_ORDER = ["hero", "categories", "combos", "features", "usual", "plus", "how_we_cook", "popular"];
const DISH_SECTIONS = ["usual", "popular"];
const isLink = (value) => value == null || /^(mealji:\/\/|https:\/\/)/.test(value);

export default async function step05(ctx) {
  const s = createSuite("05", "Home");
  const me = new Client("step05-device-001");
  await me.signIn(DEMO.customer);
  const res = await me.call("GET", "/home");
  const home = res.data || {};
  const section = (key) => (home.sections || []).find((item) => item.key === key);

  await s.run("05-01", "Home needs sign-in and loads in one call", "Home: everything comes from GET /home", async () => {
    const anon = await new Client("step05-device-anon").call("GET", "/home");
    return { ok: res.status === 200 && anon.status === 401, detail: `${res.status}/${anon.status}` };
  });
  await s.run("05-02", "Header: seasonal theme, greeting with first name, headline and search hint", "Header gradient + 2 promo images, “Good Morning, Alex!”, “What are you craving today?”, “Search for dishes, biryani, meals...”", () => {
    const theme = home.header?.header;
    const promo = home.header?.promo;
    return {
      ok: Array.isArray(theme?.backgroundColors) && theme.backgroundColors.length >= 2 && promo?.title && promo.leftImageUrl && promo.rightImageUrl
        && /^Good (morning|afternoon|evening), \S+$/.test(home.greeting) && home.headline && home.searchPlaceholder,
      detail: `${home.header?.name} · “${home.greeting}” · “${home.headline}” · “${home.searchPlaceholder}”`,
    };
  });
  await s.run("05-03", "“Deliver to” pill and delivery promise", "Header: Deliver to <label>, <city>", () => ({
    ok: home.deliverTo?.label && home.deliverTo?.line && home.serviceability?.serviceable === true && home.serviceability.etaLabel,
    detail: `${home.deliverTo?.label}, ${home.deliverTo?.line} · ${home.serviceability?.etaLabel}`,
  }));
  await s.run("05-04", "Sections come in the app's order", "Hero → Today's Menu → Meal Combos → features → Your usual? → Meal Ji Plus → How we cook → Popular", () => {
    const keys = (home.sections || []).map((item) => item.key);
    return { ok: APP_ORDER.every((key, i) => keys.indexOf(key) > -1 && (i === 0 || keys.indexOf(key) > keys.indexOf(APP_ORDER[i - 1]))), detail: keys.join(" → ") };
  });
  await s.run("05-05", "Hero cards carry eyebrow, title with highlight, subtitle, image and button", "Signature card: “OUR SIGNATURE CHICKEN BIRYANI / A BOWL OF HAPPINESS / Order Now”", () => {
    const items = section("hero")?.items || [];
    return {
      ok: items.length > 0 && items.every((b) => b.title && b.imageUrl && b.ctaLabel && (!b.highlight || b.title.includes(b.highlight)) && isLink(b.deepLink)),
      detail: items.map((b) => b.title).join(" | "),
    };
  });
  await s.run("05-06", "Today's Menu tiles: name, photo, only categories with dishes", "Today's Menu row + See all", () => {
    const items = section("categories")?.items || [];
    return { ok: items.length > 0 && items.every((c) => c.categoryId && c.name && c.imageUrl && c.dishCount > 0), detail: items.map((c) => `${c.name}(${c.dishCount})`).join(", ") };
  });
  await s.run("05-07", "Meal Combos card and combos", "“MEAL COMBOS · Great food. Better together. · Explore Combos”", () => {
    const combos = section("combos");
    const banner = combos?.banner;
    return {
      ok: banner?.title && banner.highlight && banner.title.includes(banner.highlight) && banner.ctaLabel && banner.imageUrl && (combos.items || []).every((c) => c.comboId && c.pricePaise > 0 && c.imageUrl),
      detail: `${banner?.title} [${banner?.ctaLabel}] · ${(combos?.items || []).length} combos`,
    };
  });
  await s.run("05-08", "Feature strip: 3 icons with title and subtitle", "Fast Delivery / Fresh Ingredients / Hygienic Kitchen", () => {
    const items = section("features")?.items || [];
    return { ok: items.length === 3 && items.every((f) => f.icon && f.title && f.subtitle), detail: items.map((f) => `${f.title}: ${f.subtitle}`).join(", ") };
  });
  await s.run("05-09", "Your usual: past dishes with name, price, photo", "“Your usual? · Order again in one tap” + Reorder", () => {
    const usual = section("usual");
    return { ok: usual?.title && usual.subtitle && usual.items.length > 0 && usual.items.every((d) => d.dishId && d.name && d.pricePaise > 0 && d.imageUrl), detail: (usual?.items || []).map((d) => d.name).join(", ") };
  });
  await s.run("05-10", "Meal Ji Plus: plans with monthly price and what you get", "Plus cards: ₹3,499 / ₹4,499 / ₹5,499 monthly + feature list", () => {
    const plans = section("plus")?.items || [];
    return { ok: plans.length >= 1 && plans.every((p) => p.planId && p.name && p.pricePaise > 0 && p.cycleLabel && p.benefits?.length), detail: plans.map((p) => `${p.name} ₹${p.pricePaise / 100}/${p.cycleLabel}`).join(", ") };
  });
  await s.run("05-11", "How we cook opens About chef", "How we cook banner → About chef", () => {
    const item = section("how_we_cook")?.items?.[0];
    return { ok: item?.imageUrl && item.deepLink === "mealji://about-chef", detail: `${item?.title} → ${item?.deepLink}` };
  });
  await s.run("05-12", "Cart bar: item count and “Shop for ₹X more” to free delivery", "Floating bar: Unlock Free delivery / Shop For ₹99 more / Cart badge", () => {
    const cart = home.cart || {};
    // Meal Ji Plus members already get free delivery: nothing more to add.
    const expected = cart.deliveryAlwaysFree ? 0 : Math.max(0, (cart.freeDeliveryAbovePaise || 0) - (cart.subtotalPaise || 0));
    return { ok: Number.isInteger(cart.itemCount) && cart.amountToFreeDeliveryPaise === expected && Number.isInteger(home.unreadNotifications), detail: `items ${cart.itemCount}, ₹${cart.amountToFreeDeliveryPaise / 100} to free delivery${cart.deliveryAlwaysFree ? " (Plus member: always free)" : ""}, ${home.unreadNotifications} unread` };
  });
  await s.run("05-13", "Veg toggle: only veg dishes and combos", "Header Veg / All switch", async () => {
    const veg = await me.call("GET", "/home?veg=true");
    const dishes = (veg.data?.sections || []).filter((item) => DISH_SECTIONS.includes(item.key)).flatMap((item) => item.items || []);
    const combos = (veg.data?.sections || []).find((item) => item.key === "combos")?.items || [];
    const bad = await me.call("GET", "/home?veg=maybe");
    return { ok: veg.status === 200 && veg.data.vegOnly === true && dishes.length > 0 && dishes.every((d) => d.isVeg) && combos.every((c) => c.isVeg) && bad.status === 422, detail: `${dishes.length} dishes, ${combos.length} combos, all veg · bad value ${bad.status}` };
  });
  await s.run("05-14", "Outside the delivery area: says so, no menu", "Home when the location is not served", async () => {
    const out = await me.call("GET", `/home?latitude=${POINTS.notServed.latitude}&longitude=${POINTS.notServed.longitude}`);
    const keys = (out.data?.sections || []).map((item) => item.key);
    return { ok: out.status === 200 && out.data?.serviceability?.serviceable === false && out.data.serviceability.message && !keys.some((key) => ["categories", "popular", "usual"].includes(key)), detail: `${out.data?.serviceability?.message} · sections ${keys.join(",") || "none"}` };
  });
  await s.run("05-15", "New customer: no “Your usual”, still a full home", "First visit after sign-up", async () => {
    const nc = await newCustomer(ctx);
    await nc.client.call("PUT", "/users/me/location", POINTS.served);
    const fresh = await nc.client.call("GET", "/home");
    const keys = (fresh.data?.sections || []).map((item) => item.key);
    return { ok: fresh.status === 200 && !keys.includes("usual") && keys.includes("categories") && keys.includes("popular"), detail: keys.join(",") };
  });
  await s.run("05-16", "Filters sheet options match the app", "Filters: Pure Veg / Fast Delivery / Top Rated; Relevance, Rating, Delivery Time, Cost ↑, Cost ↓; Cuisines", async () => {
    const f = (await me.call("GET", "/dishes/filters")).data || {};
    const sorts = (f.sort || []).map((item) => item.label);
    return {
      ok: (f.quick || []).map((item) => item.label).join() === "Pure Veg,Fast Delivery,Top Rated" && ["Relevance", "Rating: High to Low", "Delivery Time", "Cost: Low to High", "Cost: High to Low"].every((label) => sorts.includes(label)) && f.cuisines?.length > 0,
      detail: `${(f.quick || []).length} quick, ${sorts.length} sorts, cuisines ${(f.cuisines || []).join(", ")}`,
    };
  });
  await s.run("05-17", "Applying filters returns matching dishes in order", "Filters: Apply", async () => {
    const r = await me.call("GET", "/dishes?quick=veg,fast&sort=prep_time");
    const items = r.data?.items || [];
    const sorted = items.every((d, i) => i === 0 || (items[i - 1].preparationMinutes ?? 999) <= (d.preparationMinutes ?? 999));
    const multi = await me.call("GET", "/dishes?cuisine=North Indian,Fusion");
    const cuisines = new Set((multi.data?.items || []).map((d) => d.cuisine));
    const top = await me.call("GET", "/dishes?quick=top_rated&sort=rating");
    const bad = await me.call("GET", "/dishes?quick=cheap");
    return {
      ok: r.status === 200 && items.length > 0 && items.every((d) => d.isVeg && d.preparationMinutes <= 15) && sorted
        && cuisines.size === 2 && (top.data?.items || []).every((d) => d.rating >= 4.5) && bad.status === 422,
      detail: `veg+fast ${items.length}, cuisines ${[...cuisines].join("/")}, top rated ${(top.data?.items || []).length}, bad chip ${bad.status}`,
    };
  });
  await s.run("05-18", "Banner taps are counted", "Hero/combos card tap", async () => {
    const id = section("hero")?.items?.[0]?.bannerId;
    const click = await me.call("POST", `/banners/${id}/click`);
    const bad = await me.call("POST", `/banners/${id}/like`);
    return { ok: click.status === 200 && bad.status === 422, detail: `${click.status}/${bad.status}` };
  });
  await s.run("05-19", "In-app messages for the home screen", "Popups/announcements on Home", async () => {
    const msgs = await me.call("GET", "/in-app-messages?screen=home");
    const missing = await me.call("GET", "/in-app-messages");
    return { ok: msgs.status === 200 && Array.isArray(msgs.data) && missing.status === 422, detail: `${msgs.status} ${msgs.data?.length} messages · without screen ${missing.status}` };
  });
  await s.run("05-20", "Every image on Home loads", "No broken images", async () => {
    const urls = new Set([home.header?.promo?.leftImageUrl, home.header?.promo?.rightImageUrl, home.header?.header?.backgroundImageUrl]);
    for (const item of home.sections || []) {
      if (item.banner?.imageUrl) urls.add(item.banner.imageUrl);
      for (const entry of item.items || []) urls.add(entry.imageUrl);
    }
    const list = [...urls].filter(Boolean);
    const broken = [];
    for (const url of list) if (!(await headOk(url))) broken.push(url);
    return { ok: broken.length === 0, detail: `${list.length - broken.length}/${list.length} load${broken.length ? ` · broken ${broken.slice(0, 2).join(", ")}` : ""}` };
  });

  // ---- About chef
  const about = await me.call("GET", "/kitchen-about");
  const a = about.data || {};
  await s.run("05-21", "About chef has everything the screen shows", "Hero photo + “FOUNDED 2024 • GREATER NOIDA”, “THE MAN BEHIND THE FLAME”, quote, “— Chef Mujahid Khan”, 2 paragraphs", () => ({
    ok: about.status === 200 && a.imageUrl && a.tagline && a.title && a.quote && a.chefName && a.paragraphs?.length >= 2,
    detail: `${a.tagline} · ${a.title} · ${a.chefName} · ${a.paragraphs?.length} paragraphs`,
  }));
  await s.run("05-22", "“The Meal Ji Standard” points and the menu button", "3 points with icon, title, description; “Taste the Menu” → Menu", () => ({
    ok: a.standardTitle && a.pillars?.length === 3 && a.pillars.every((p) => p.icon && p.title && p.description) && a.ctaLabel && a.ctaDeepLink?.startsWith("mealji://"),
    detail: `${a.standardTitle}: ${(a.pillars || []).map((p) => `${p.icon} ${p.title}`).join(", ")} · [${a.ctaLabel}] → ${a.ctaDeepLink}`,
  }));
  await s.run("05-23", "About photos load", "Hero image and gallery", async () => {
    const urls = [a.imageUrl, ...(a.gallery || [])].filter(Boolean);
    const results = await Promise.all(urls.map(headOk));
    return { ok: urls.length > 0 && results.every(Boolean), detail: `${results.filter(Boolean).length}/${urls.length} load` };
  });
  await s.run("05-24", "About editor refuses bad content", "Admin: Content → About the chef", async () => {
    const admin = new Client("step05-admin-001");
    await admin.signIn(DEMO.admin, { staff: true });
    const path = `/admin/kitchens/${a.kitchenId}/about`;
    const badPillars = await admin.call("PUT", path, { pillars: [{ title: "", description: "x" }] });
    const badLink = await admin.call("PUT", path, { ctaDeepLink: "javascript:alert(1)" });
    const badImage = await admin.call("PUT", path, { imageUrl: "https://evil.example.com/a.jpg" });
    const save = await admin.call("PUT", path, { quote: a.quote });
    return { ok: badPillars.status === 422 && badLink.status === 422 && badImage.status >= 400 && badImage.status < 500 && save.status === 200 && save.data?.pillars?.length === 3, detail: `${badPillars.status}/${badLink.status}/${badImage.status}/${save.status}` };
  });
  return s;
}
