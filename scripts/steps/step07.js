// Step 07 · Search and favourites — Search and Favourites screens (and hearts everywhere).
import { Client, createSuite, db, DEMO } from "./harness.js";

export default async function step07(ctx) {
  const s = createSuite("07", "Search and favourites");
  const me = new Client("step07-device-001");
  await me.signIn(DEMO.customer);

  // ---- search
  await s.run("07-01", "Trending searches for the empty search screen", "“Trending searches” chips (Butter chicken, Bao, Ramen… Under ₹200)", async () => {
    const res = await me.call("GET", "/search/trending");
    const words = (res.data || []).filter((t) => t.type === "query");
    const price = (res.data || []).find((t) => t.type === "filter");
    // The price chip opens the dish list with its filters; check those filters work there.
    const under = price ? await me.call("GET", `/dishes?maxPricePaise=${price.filters.maxPricePaise}&sort=${price.filters.sort}`) : null;
    return {
      ok: res.status === 200 && words.length >= 4 && words.every((t) => t.query && t.label === t.query) && price?.label === "Under ₹200" && under?.status === 200 && (under.data.items || []).every((d) => d.pricePaise <= price.filters.maxPricePaise),
      detail: `${res.data.map((t) => t.label).join(", ")} · Under ₹200 → ${under?.data?.items?.length} dishes`,
    };
  });
  await s.run("07-02", "Results: count, dishes with badge, veg mark, price, photo, heart", "“2 dishes match \"butter\"” + cards with Add +", async () => {
    const res = await me.call("GET", "/search?q=butter");
    const dishes = res.data?.dishes || [];
    return { ok: res.status === 200 && res.data.dishCount === dishes.length && dishes.length > 0 && dishes.every((x) => /butter/i.test(`${x.name} ${x.description} ${x.tags.join(" ")}`) && x.imageUrl && x.pricePaise > 0 && typeof x.isVeg === "boolean" && typeof x.isFavorite === "boolean") && res.data.searchId, detail: `${dishes.length} dishes: ${dishes.map((x) => x.name).join(", ")}` };
  });
  await s.run("07-03", "A small typo still finds the dish", "Users type “briyani”, “panner”", async () => {
    const typo = (await me.call("GET", "/search?q=briyani")).data?.dishes || [];
    const typo2 = (await me.call("GET", "/search?q=panner")).data?.dishes || [];
    return { ok: typo.some((x) => /biryani/i.test(x.name)) && typo2.some((x) => /paneer/i.test(x.name)), detail: `briyani → ${typo.length}, panner → ${typo2.length}` };
  });
  await s.run("07-04", "No results: suggestions and popular dishes", "“No results found” + “Try these instead” + “Popular right now”", async () => {
    const res = await me.call("GET", "/search?q=sushi");
    return { ok: res.data?.total === 0 && res.data.suggestions?.length > 0 && res.data.popular?.length > 0 && res.data.popular.every((x) => typeof x.isFavorite === "boolean"), detail: `try: ${(res.data?.suggestions || []).join(", ")} · popular ${(res.data?.popular || []).length}` };
  });
  await s.run("07-05", "Veg search and the user's location", "Veg switch on; search near the selected address", async () => {
    const veg = (await me.call("GET", "/search?q=biryani&veg=true")).data?.dishes || [];
    const near = await me.call("GET", "/search?q=biryani&latitude=12.942795&longitude=77.624478");
    const far = await me.call("GET", "/search?q=biryani&latitude=13.1986&longitude=77.7066");
    return { ok: veg.length > 0 && veg.every((x) => x.isVeg) && near.status === 200 && far.status === 409, detail: `veg ${veg.length} · near ${near.status} · not delivered ${far.status}` };
  });
  await s.run("07-06", "Typing does not fill Recent with every letter", "Recent shows “paneer”, not “p, pa, pan…”", async () => {
    await me.call("DELETE", "/search/recent");
    for (const q of ["p", "pa", "pan", "pane", "paneer"]) await me.call("GET", `/search?q=${q}`);
    const recent = ((await me.call("GET", "/search/recent")).data || []).map((r) => r.query);
    return { ok: recent[0] === "paneer" && !recent.some((q) => ["p", "pa", "pan", "pane"].includes(q)), detail: recent.join(", ") };
  });
  await s.run("07-07", "Recent: remove one, clear all", "Recent rows and clear", async () => {
    await me.call("GET", "/search?q=kulfi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const one = await me.call("DELETE", "/search/recent/kulfi");
    const after = ((await me.call("GET", "/search/recent")).data || []).map((r) => r.query);
    const clear = await me.call("DELETE", "/search/recent");
    const empty = (await me.call("GET", "/search/recent")).data || [];
    return { ok: one.status === 200 && !after.includes("kulfi") && clear.status === 200 && empty.length === 0, detail: `after remove: ${after.join(", ")} · after clear ${empty.length}` };
  });
  await s.run("07-08", "Tapping a result is counted; unknown search is 404", "Search analytics", async () => {
    const res = await me.call("GET", "/search?q=bao");
    const click = await me.call("POST", `/search/${res.data?.searchId}/click`, { dishId: res.data?.dishes?.[0]?.dishId });
    const unknown = await me.call("POST", "/search/000000000000000000000000/click", { dishId: res.data?.dishes?.[0]?.dishId });
    return { ok: click.status === 200 && unknown.status === 404, detail: `${click.status}/${unknown.status}` };
  });
  await s.run("07-09", "Bad search input is refused", "Empty / too long / not text", async () => {
    const statuses = [];
    for (const q of ["", "x".repeat(61), "q[$ne]=1"]) statuses.push((await me.call("GET", q.startsWith("q[") ? `/search?${q}` : `/search?q=${q}`)).status);
    return { ok: statuses.every((status) => status === 422), detail: statuses.join(",") };
  });

  // ---- search + filters in one call
  await s.run("07-17", "Search and filters together: every result matches the word and the filters", "Search → filter button → Pure Veg / Top Rated / cuisine / price", async () => {
    const veg = (await me.call("GET", "/search?q=biryani&veg=true")).data;
    const top = (await me.call("GET", "/search?q=biryani&quick=top_rated")).data;
    const cuisine = (await me.call("GET", "/search?q=briyani&cuisine=Hyderabadi,North Indian")).data;
    const price = (await me.call("GET", "/search?q=biryani&minPricePaise=25000&maxPricePaise=33000")).data;
    const fast = (await me.call("GET", "/search?q=paneer&quick=veg,fast")).data;
    return {
      ok: veg.dishes.length > 0 && veg.dishes.every((d) => d.isVeg && /biryani/i.test(`${d.name} ${d.tags.join(" ")}`))
        && top.dishes.every((d) => d.ratingAvg >= 4.5)
        && cuisine.dishes.length > 0 && cuisine.dishes.every((d) => ["hyderabadi", "north indian"].includes(String(d.cuisine).toLowerCase()))
        && price.dishes.length > 0 && price.dishes.every((d) => d.pricePaise >= 25000 && d.pricePaise <= 33000)
        && fast.dishes.every((d) => d.isVeg && d.preparationMinutes <= 15)
        && veg.filtersApplied.includes("veg") && top.filtersApplied.includes("quick:top_rated"),
      detail: `veg ${veg.dishCount} · top rated ${top.dishCount} · typo+cuisine ${cuisine.dishCount} · ₹250–330 ${price.dishCount} · veg+fast ${fast.dishCount}`,
    };
  });
  await s.run("07-18", "Sort the search results; without sort the best match stays first", "Sort by: Relevance / Rating / Delivery Time / Cost ↑ / Cost ↓", async () => {
    const asc = (await me.call("GET", "/search?q=biryani&sort=price_asc")).data.dishes.map((d) => d.pricePaise);
    const desc = (await me.call("GET", "/search?q=biryani&sort=price_desc")).data.dishes.map((d) => d.pricePaise);
    const rating = (await me.call("GET", "/search?q=biryani&sort=rating")).data.dishes.map((d) => d.ratingAvg);
    const plain = (await me.call("GET", "/search?q=biryani")).data.dishes.map((d) => d.name);
    const relevance = (await me.call("GET", "/search?q=biryani&sort=relevance")).data.dishes.map((d) => d.name);
    const sorted = (list, dir) => list.every((v, i) => i === 0 || (dir > 0 ? list[i - 1] <= v : list[i - 1] >= v));
    return { ok: asc.length > 1 && sorted(asc, 1) && sorted(desc, -1) && sorted(rating, -1) && plain.join() === relevance.join(), detail: `₹ ${asc.map((p) => p / 100).join(" < ")} · rating ${rating.join(" ≥ ")}` };
  });
  await s.run("07-19", "Search results page with “load more”", "Long result lists", async () => {
    const all = (await me.call("GET", "/search?q=biryani&sort=price_asc")).data;
    const p1 = (await me.call("GET", "/search?q=biryani&sort=price_asc&limit=2&page=1")).data;
    const p2 = (await me.call("GET", "/search?q=biryani&sort=price_asc&limit=2&page=2")).data;
    const bad = await me.call("GET", "/search?q=biryani&limit=500");
    return { ok: p1.dishes.length === 2 && p1.hasMore === true && p1.dishCount === all.dishCount && p2.dishes[0]?.dishId === all.dishes[2]?.dishId && bad.status === 422, detail: `${all.dishCount} results · page 1 ${p1.dishes.length} (more ${p1.hasMore}) · page 2 starts with #3 · limit 500 ${bad.status}` };
  });
  await s.run("07-20", "Filters that remove everything say so (Clear filters)", "Empty result because of filters vs no match at all", async () => {
    const none = (await me.call("GET", "/search?q=biryani&maxPricePaise=5000")).data;
    const nothing = (await me.call("GET", "/search?q=sushi")).data;
    return {
      ok: none.total === 0 && none.filteredOut === true && none.matchesWithoutFilters > 0 && none.emptyMessage === "No dishes match these filters" && none.popular.length > 0
        && nothing.filteredOut === false && /couldn't find/.test(nothing.emptyMessage) && nothing.suggestions.length > 0,
      detail: `filters: “${none.emptyMessage}” (${none.matchesWithoutFilters} without filters) · no match: “${nothing.emptyMessage}”`,
    };
  });
  await s.run("07-21", "Same filter values and errors as the dish list", "One Filters sheet for Home and Search", async () => {
    const statuses = [];
    for (const q of ["quick=cheap", "sort=cheapest", "cuisine=" + "x".repeat(130), "minPricePaise=-1", "categoryId=x", "slot=midnight"]) {
      statuses.push(`${(await me.call("GET", `/search?q=biryani&${q}`)).status}/${(await me.call("GET", `/dishes?${q}`)).status}`);
    }
    return { ok: statuses.every((pair) => pair === "422/422"), detail: statuses.join(" ") };
  });
  await s.run("07-22", "Combos follow veg and price filters; dish-only filters leave them out", "Combos in search results", async () => {
    const plain = (await me.call("GET", "/search?q=biryani")).data;
    const cheap = (await me.call("GET", "/search?q=biryani&maxPricePaise=100000")).data;
    const top = (await me.call("GET", "/search?q=biryani&quick=top_rated")).data;
    return { ok: plain.combos.length > 0 && cheap.combos.every((c) => c.pricePaise <= 100000) && top.combos.length === 0, detail: `combos: plain ${plain.combos.length} · ≤₹1000 ${cheap.combos.length} · top rated ${top.combos.length}` };
  });

  // ---- favourites
  const dishes = (await me.call("GET", "/dishes?limit=100")).data?.items || [];
  const target = dishes.find((x) => x.name === "Egg Biryani");
  await s.run("07-10", "Heart a dish: first time 201, again 200", "Heart on cards and dish detail", async () => {
    await me.call("DELETE", `/users/me/favorites/${target.dishId}`);
    const add1 = await me.call("POST", "/users/me/favorites", { dishId: target.dishId });
    const add2 = await me.call("POST", "/users/me/favorites", { dishId: target.dishId });
    const detail = await me.call("GET", `/menu/items/${target.dishId}`);
    return { ok: add1.status === 201 && add2.status === 200 && detail.data?.isFavorite === true, detail: `${add1.status}/${add2.status} · detail heart ${detail.data?.isFavorite}` };
  });
  await s.run("07-11", "Favourites list: newest first, can it be ordered here, from which kitchen", "Favourites screen cards + Add +", async () => {
    const res = await me.call("GET", "/users/me/favorites");
    const list = res.data || [];
    return { ok: res.status === 200 && list[0]?.dishId === target.dishId && list.every((x) => x.isFavorite === true && x.kitchenName && typeof x.orderableHere === "boolean" && x.pricePaise > 0 && x.imageUrl), detail: list.map((x) => `${x.name}${x.orderableHere ? "" : " (not here)"}`).join(", ") };
  });
  await s.run("07-12", "Profile shows the favourites count", "Profile tile “Favorites 4”", async () => {
    const profile = await me.call("GET", "/users/me");
    const list = (await me.call("GET", "/users/me/favorites")).data || [];
    return { ok: profile.data?.stats?.favorites === list.length, detail: `${profile.data?.stats?.favorites} / ${list.length}` };
  });
  await s.run("07-13", "Un-heart removes it everywhere", "Tap the heart again", async () => {
    const del = await me.call("DELETE", `/users/me/favorites/${target.dishId}`);
    const list = (await me.call("GET", "/users/me/favorites")).data || [];
    const card = ((await me.call("GET", "/dishes?limit=100")).data?.items || []).find((x) => x.dishId === target.dishId);
    return { ok: del.status === 200 && !list.some((x) => x.dishId === target.dishId) && card?.isFavorite === false, detail: `${del.status} · in list ${list.some((x) => x.dishId === target.dishId)} · card heart ${card?.isFavorite}` };
  });
  await s.run("07-14", "Hidden or unpublished dishes cannot be saved", "Only live dishes", async () => {
    const database = await db();
    const mongoose = (await import("mongoose")).default;
    const pending = await database.collection("kitchendishes").insertOne({ kitchen: new mongoose.Types.ObjectId(target.kitchenId), name: "STEP07 PENDING", pricePaise: 100, isActive: true, isAvailable: true, approvalStatus: "pending", isVeg: true, images: [], createdAt: new Date(), updatedAt: new Date() });
    ctx.cleanups.push(() => database.collection("kitchendishes").deleteOne({ _id: pending.insertedId }));
    const res = await me.call("POST", "/users/me/favorites", { dishId: String(pending.insertedId) });
    const bad = await me.call("POST", "/users/me/favorites", { dishId: "nope" });
    return { ok: res.status === 404 && bad.status === 422, detail: `${res.status}/${bad.status}` };
  });
  await s.run("07-15", "A favourite from another kitchen is marked “not here”", "Saved dish from a kitchen that does not deliver to you", async () => {
    const database = await db();
    const indiranagar = await database.collection("kitchens").findOne({ phoneNumber: "9000000021" });
    const other = await database.collection("kitchendishes").findOne({ kitchen: indiranagar._id, approvalStatus: "live", isActive: true });
    await me.call("POST", "/users/me/favorites", { dishId: String(other._id) });
    const list = (await me.call("GET", "/users/me/favorites")).data || [];
    await me.call("DELETE", `/users/me/favorites/${other._id}`);
    const item = list.find((x) => x.dishId === String(other._id));
    return { ok: item && item.orderableHere === false && item.kitchenName === indiranagar.name, detail: `${item?.name} from ${item?.kitchenName}: orderableHere ${item?.orderableHere}` };
  });
  await s.run("07-16", "Popular picks for the empty favourites screen", "“Popular Picks for You”", async () => {
    const res = await me.call("GET", "/menu/popular");
    return { ok: res.status === 200 && res.data.length >= 4 && res.data.every((x) => typeof x.isFavorite === "boolean"), detail: res.data.slice(0, 4).map((x) => x.name).join(", ") };
  });
  return s;
}
