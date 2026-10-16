// Step 06 · Menu and dish — Menu, Dish detail and Combos screens.
import { Client, createSuite, DEMO, headOk } from "./harness.js";

export default async function step06() {
  const s = createSuite("06", "Menu and dish");
  const me = new Client("step06-device-001");
  await me.signIn(DEMO.customer);
  const menuRes = await me.call("GET", "/menu");
  const menu = menuRes.data || {};
  const allDishes = (menu.categories || []).flatMap((category) => category.dishes || []);
  const bowl = allDishes.find((dish) => dish.name === "Butter Chicken Bowl");

  await s.run("06-01", "Menu: categories with name, tagline and photo, dishes inside each", "Menu tabs (Biryani, Meals, Curries…) + “Aromatic. Authentic. Always a good idea.”", () => ({
    ok: menuRes.status === 200 && menu.categories?.length > 0 && menu.categories.every((c) => c.categoryId && c.name && c.imageUrl && c.dishes.length > 0) && menu.categories.some((c) => c.subtitle),
    detail: (menu.categories || []).map((c) => `${c.name}(${c.dishes.length})`).join(", "),
  }));
  await s.run("06-02", "Each dish appears once", "No duplicate cards", () => {
    const ids = allDishes.map((dish) => dish.dishId);
    return { ok: ids.length > 0 && new Set(ids).size === ids.length && !("dishes" in menu), detail: `${ids.length} dishes` };
  });
  await s.run("06-03", "Dish cards carry what the grid shows", "Card: photo, Bestseller badge, heart, name, 2-line description, price, Add +", () => ({
    ok: allDishes.every((d) => d.dishId && d.name && d.imageUrl && Number.isInteger(d.pricePaise) && typeof d.isVeg === "boolean" && typeof d.isFavorite === "boolean" && typeof d.isBestseller === "boolean" && typeof d.isAvailable === "boolean"),
    detail: `${allDishes.filter((d) => d.isFavorite).length} hearts on, ${allDishes.filter((d) => d.isBestseller).length} bestsellers`,
  }));
  await s.run("06-04", "Menu says whether the kitchen can take orders now", "Closed / paused state", () => ({
    ok: typeof menu.kitchen?.isOpenNow === "boolean" && "closedMessage" in menu.kitchen && typeof menu.kitchen.open24Hours === "boolean" && (menu.kitchen.open24Hours || menu.kitchen.opensAt),
    detail: `${menu.kitchen?.name} open ${menu.kitchen?.isOpenNow} (${menu.kitchen?.open24Hours ? "24 hours" : `${menu.kitchen?.opensAt}–${menu.kitchen?.closesAt}`})`,
  }));
  await s.run("06-05", "The app's own menu path works", "menuApi.ts: GET /kitchens/{id}/menu", async () => {
    const res = await me.call("GET", `/kitchens/${menu.kitchen?.kitchenId}/menu`);
    const bad = await me.call("GET", "/kitchens/not-an-id/menu");
    return { ok: res.status === 200 && res.data?.categories?.length === menu.categories?.length && bad.status === 422, detail: `${res.status}/${bad.status}` };
  });
  await s.run("06-06", "Wrong menu filters are refused clearly", "Bad parameters", async () => {
    const results = [];
    for (const q of ["categoryId=x", "slot=midnight", "availableOnly=maybe", "sort=cheapest", "q[$ne]=x", "minPricePaise=-1"]) results.push((await me.call("GET", `/dishes?${q}`)).status);
    return { ok: results.every((status) => status === 422), detail: results.join(",") };
  });

  // ---- dish detail
  const detailRes = await me.call("GET", `/menu/items/${bowl?.dishId}`);
  const d = detailRes.data || {};
  await s.run("06-07", "Dish detail: the top of the screen", "MOST POPULAR badge, name, price, ★ rating (reviews), prep minutes, Serves, description", () => ({
    ok: detailRes.status === 200 && d.name && d.pricePaise > 0 && d.badge && typeof d.ratingAvg === "number" && Number.isInteger(d.ratingCount) && d.preparationMinutes > 0 && d.servesCount >= 1 && d.description,
    detail: `${d.badge} · ${d.name} ₹${d.pricePaise / 100} · ★${d.ratingAvg} (${d.ratingCount}) · ${d.preparationMinutes} min · serves ${d.servesCount}`,
  }));
  await s.run("06-08", "Feature badges and heart", "Fresh Ingredients / Slow Cooked / Halal Certified; heart filled when saved", () => ({
    ok: d.highlights?.length >= 3 && typeof d.isFavorite === "boolean",
    detail: `${(d.highlights || []).join(", ")} · favourite ${d.isFavorite}`,
  }));
  await s.run("06-09", "Portions: name, serves and price, one default", "“Select a portion”: Regular · Serves 1 / Large · Serves 2 / Family Pack · Serves 3-4", () => ({
    ok: d.portions?.length >= 2 && d.portions.every((p) => p.portionId && p.label && p.serves && p.pricePaise > 0) && d.portions.filter((p) => p.isDefault).length === 1,
    detail: (d.portions || []).map((p) => `${p.label} ${p.serves} ₹${p.pricePaise / 100}`).join(" | "),
  }));
  await s.run("06-10", "Option groups say required, single or multi, and price of each option", "Choose Rice Portion (required, pick 1) / Add a Side (optional)", () => ({
    ok: d.customizationGroups?.length > 0 && d.customizationGroups.every((g) => typeof g.required === "boolean" && typeof g.multiple === "boolean" && g.maxSelect >= 1 && g.options.every((o) => o.optionId && o.name && Number.isInteger(o.pricePaise))),
    detail: (d.customizationGroups || []).map((g) => `${g.name} req ${g.required} max ${g.maxSelect}`).join(" | "),
  }));
  await s.run("06-11", "“Make it a meal” card", "Complete Meal · components · ~~₹417~~ ₹349 · Save ₹68 · photo", () => {
    const m = d.mealUpgrade;
    return { ok: m?.label && m.description && m.pricePaise > 0 && m.originalPricePaise > m.pricePaise && m.savingsPaise === m.originalPricePaise - m.pricePaise && m.imageUrl, detail: `${m?.label}: ${m?.description} +₹${m?.pricePaise / 100} (save ₹${m?.savingsPaise / 100})` };
  });
  await s.run("06-12", "“From the chef” card", "Chef's note and “— Chef, Meal Ji”", () => ({
    ok: d.chef?.name && d.chef.note,
    detail: `${d.chef?.name}: “${String(d.chef?.note).slice(0, 50)}…”`,
  }));
  await s.run("06-13", "You may also like", "Recommendations with price and +", async () => {
    const recs = await me.call("GET", `/menu/items/${bowl?.dishId}/recommendations`);
    const unknown = await me.call("GET", "/menu/items/000000000000000000000000/recommendations");
    return { ok: recs.status === 200 && recs.data.length > 0 && recs.data.every((r) => r.dishId !== bowl?.dishId && r.pricePaise > 0 && typeof r.isFavorite === "boolean") && unknown.status === 404, detail: `${(recs.data || []).map((r) => r.name).join(", ")} · unknown ${unknown.status}` };
  });
  await s.run("06-14", "A dish outside its hours says when it is available", "Sold out / not now state", async () => {
    const { istParts } = await import("../../src/common/time.js");
    const hour = istParts(new Date()).hour;
    const other = hour >= 7 && hour < 11 ? "dinner" : "breakfast";
    const papad = allDishes.find((dish) => dish.name === "Masala Papad");
    // Through the admin API, so the menu cache is refreshed like a real edit.
    const admin = new Client("step06-admin-001");
    await admin.signIn(DEMO.admin, { staff: true });
    const path = `/admin/kitchens/${menu.kitchen.kitchenId}/menu/dishes/${papad.dishId}`;
    const before = (await admin.call("GET", path)).data;
    const set = await admin.call("PATCH", path, { availableSlots: [other] });
    const view = await me.call("GET", `/menu/items/${papad.dishId}`);
    await admin.call("PATCH", path, { availableSlots: before?.availableSlots || [] });
    if (set.status !== 200) return { ok: false, detail: `admin edit ${set.status} ${set.message}` };
    return { ok: view.data?.isAvailable === false && view.data.unavailableReason === "outside_slot" && view.data.unavailableMessage, detail: `${view.data?.unavailableReason}: ${view.data?.unavailableMessage}` };
  });
  await s.run("06-15", "Unknown dish is a 404", "Deep link to a removed dish", async () => {
    const res = await me.call("GET", "/menu/items/000000000000000000000000");
    return { ok: res.status === 404, detail: String(res.status) };
  });

  // ---- combos
  const combosRes = await me.call("GET", "/combos");
  const combos = combosRes.data || [];
  await s.run("06-16", "Combo cards: title, items, price, original price, Save ₹X, badge, photo", "“Bao & Bowl · Paneer bao + dal ramen · ₹449 ~~₹538~~ Save ₹89 · BESTSELLER”", () => ({
    ok: combosRes.status === 200 && combos.length > 0 && combos.every((c) => c.comboId && c.name && c.subtitle && c.imageUrl && c.pricePaise > 0 && Number.isInteger(c.savingsPaise) && c.items.every((i) => i.name && Number.isInteger(i.pricePaise))) && combos.some((c) => c.badge),
    detail: combos.map((c) => `${c.name} ₹${c.pricePaise / 100} save ₹${c.savingsPaise / 100}${c.badge ? ` [${c.badge}]` : ""}`).join(" | "),
  }));
  await s.run("06-17", "Combos carry no internal fields", "Customer view only", () => ({
    ok: combos.every((c) => !("approvalStatus" in c) && !("isActive" in c) && !("sortOrder" in c)),
    detail: Object.keys(combos[0] || {}).join(","),
  }));
  await s.run("06-18", "Combo chips: All / For one / For two / Family / Under ₹500", "Combos screen filter chips", async () => {
    const chips = (await me.call("GET", "/combos/filters")).data?.chips || [];
    const two = (await me.call("GET", "/combos?chip=two")).data || [];
    const under = (await me.call("GET", "/combos?chip=under_500")).data || [];
    const bad = await me.call("GET", "/combos?chip=cheap");
    return {
      ok: chips.map((c) => c.label).join() === "All,For one,For two,Family,Under ₹500" && two.length > 0 && two.every((c) => c.servesCount === 2) && under.every((c) => c.pricePaise < 50000) && bad.status === 422,
      detail: `two: ${two.map((c) => c.name).join(", ")} · under ₹500: ${under.length} · bad ${bad.status}`,
    };
  });
  await s.run("06-19", "One combo by id", "Combo detail / deep link", async () => {
    const one = await me.call("GET", `/combos/${combos[0]?.comboId}`);
    const unknown = await me.call("GET", "/combos/000000000000000000000000");
    return { ok: one.status === 200 && one.data?.comboId === combos[0]?.comboId && unknown.status === 404, detail: `${one.status}/${unknown.status}` };
  });
  await s.run("06-20", "Every menu, dish and combo image loads", "No broken images", async () => {
    const urls = [...new Set([...menu.categories.map((c) => c.imageUrl), ...allDishes.map((x) => x.imageUrl), ...combos.map((c) => c.imageUrl), d.mealUpgrade?.imageUrl].filter(Boolean))];
    const results = await Promise.all(urls.map(headOk));
    return { ok: results.every(Boolean), detail: `${results.filter(Boolean).length}/${urls.length} load` };
  });
  await s.run("06-21", "Veg / All: the saved choice applies on every list; the toggle changes it; ?veg overrides one call", "Header Veg / All switch (remembered)", async () => {
    const before = (await me.call("GET", "/users/me/preferences")).data?.vegOnly;
    const nonVeg = (list) => (list || []).filter((d) => d.isVeg === false).length;
    // Toggle ON (what the app does when the user flips the switch).
    const flip = await me.call("PATCH", "/users/me/preferences", { vegOnly: true });
    const home = (await me.call("GET", "/home")).data;
    const homeDishes = (home.sections || []).filter((sec) => ["usual", "popular"].includes(sec.key)).flatMap((sec) => sec.items || []);
    const menuV = (await me.call("GET", "/menu")).data;
    const dishesV = (await me.call("GET", "/dishes?limit=100")).data;
    const combosV = (await me.call("GET", "/combos")).data;
    const searchV = (await me.call("GET", "/search?q=biryani")).data;
    const popularV = (await me.call("GET", "/menu/popular")).data;
    const recsV = (await me.call("GET", `/menu/items/${bowl.dishId}/recommendations`)).data;
    // One call that overrides the saved choice without changing it.
    const override = (await me.call("GET", "/dishes?veg=false&limit=100")).data;
    const still = (await me.call("GET", "/users/me/preferences")).data?.vegOnly;
    // Toggle OFF again.
    await me.call("PATCH", "/users/me/preferences", { vegOnly: false });
    const dishesAll = (await me.call("GET", "/dishes?limit=100")).data;
    await me.call("PATCH", "/users/me/preferences", { vegOnly: Boolean(before) });
    const vegLists = [homeDishes, menuV.categories.flatMap((c) => c.dishes), dishesV.items, combosV, searchV.dishes, popularV, recsV];
    return {
      ok: flip.status === 200 && home.vegOnly === true && menuV.vegOnly === true && dishesV.vegOnly === true && searchV.vegOnly === true && vegLists.every((list) => nonVeg(list) === 0)
        && dishesV.items.length > 0 && override.vegOnly === false && nonVeg(override.items) > 0 && still === true
        && dishesAll.vegOnly === false && nonVeg(dishesAll.items) > 0,
      detail: `toggle on → non-veg on Home/Menu/Dishes/Combos/Search/Popular/Suggestions: ${vegLists.map(nonVeg).join("/")} · ?veg=false shows ${nonVeg(override.items)} non-veg, saved stays ${still} · toggle off → ${nonVeg(dishesAll.items)} non-veg`,
    };
  });
  await s.run("06-22", "Menu tabs, header cards and dish badges as the app draws them", "Menu tabs with icons · MEAL COMBOS card · Combos header · Dish badges, Share, Make it a meal", async () => {
    const menu = (await me.call("GET", "/menu")).data;
    const [menuHero, intro, hero] = await Promise.all(["menu_hero", "combos_intro", "combos_hero"].map(async (p) => (await me.call("GET", `/banners?placement=${p}`)).data || []));
    const dish = menu.categories.flatMap((c) => c.dishes).find((d) => d.mealUpgrade && d.highlights.length);
    const detail = (await me.call("GET", `/menu/items/${dish.dishId}`)).data;
    const u = detail.mealUpgrade;
    const combos = (await me.call("GET", "/combos")).data || [];
    const tabsOk = menu.categories.every((c) => /^[a-z0-9-]+$/.test(c.slug) && c.icon);
    return {
      ok: tabsOk && menu.categories.some((c) => c.slug === "biryani") && menuHero[0]?.title === "MEAL COMBOS" && menuHero[0]?.ctaLabel === "Explore Combos" && intro[0]?.eyebrow === "Curated by the chef" && hero[0]?.ctaLabel === "Signature Meal"
        && detail.highlightBadges.every((b) => b.label && b.icon) && detail.deepLink === `mealji://dish/${detail.dishId}` && detail.shareText && (detail.shareUrl === null || detail.shareUrl.includes(detail.dishId))
        && u.totalPricePaise === detail.pricePaise + u.pricePaise && u.totalOriginalPricePaise - u.totalPricePaise === u.totalSavingsPaise && !combos.some((c) => /^save/i.test(c.badge || "")),
      detail: `tabs ${menu.categories.map((c) => `${c.slug}:${c.icon}`).join(" ")} · ${menuHero[0]?.title} / ${hero[0]?.ctaLabel} · ${detail.highlightBadges.map((b) => `${b.label}:${b.icon}`).join(", ")} · meal ₹${u.totalOriginalPricePaise / 100}→₹${u.totalPricePaise / 100}`,
    };
  });
  return s;
}
