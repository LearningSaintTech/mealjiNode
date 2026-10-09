// Step 07 · Search and favourites — Search and Favourites screens (and hearts everywhere).
import { Client, createSuite, db, DEMO } from "./harness.js";

export default async function step07(ctx) {
  const s = createSuite("07", "Search and favourites");
  const me = new Client("step07-device-001");
  await me.signIn(DEMO.customer);

  // ---- search
  await s.run("07-01", "Trending searches for the empty search screen", "“Trending searches” chips (Butter chicken, Bao, Ramen…)", async () => {
    const res = await me.call("GET", "/search/trending");
    return { ok: res.status === 200 && res.data.length >= 4 && res.data.every((t) => t.query), detail: res.data.map((t) => t.query).join(", ") };
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
