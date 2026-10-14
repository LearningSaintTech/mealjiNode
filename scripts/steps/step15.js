// Step 15 · Meal Ji Plus: meal plan — Plan confirmed → Choose Meal Slot,
// Prepare Today's Lunch (menu), Meal summary, Meal confirmed (“Your Lunch Meal
// is Confirmed!”, What's Next?), Shift today's meal (confirm + success).
// Demo member 9000000037 (Premium, up to 3 items a meal); every meal and plan
// date changed here is put back afterwards.
import mongoose from "mongoose";
import { Client, createSuite, db, headOk } from "./harness.js";

const DAY = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} [A-Z][a-z]{2} \d{4}$/; // “Mon, 28 Sep 2026”
const TIME = /^\d{1,2}:\d{2} (AM|PM)$/;
const istKey = (offset = 0) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
const weekday = (key) => new Date(`${key}T12:00:00+05:30`).getUTCDay();

export default async function step15(ctx) {
  const s = createSuite("15", "Meal Ji Plus: meal plan");
  const database = await db();
  const me = new Client("step15-device-001");
  await me.signIn("9000000037");
  const outsider = new Client("step15-device-002");
  await outsider.signIn("9000000038");
  const userId = new mongoose.Types.ObjectId(me.session.user.userId);
  const sub = await database.collection("subscriptions").findOne({ user: userId, status: "active" });
  const meals = await database.collection("mealselections").find({ subscription: sub._id }).toArray();
  const startedAt = new Date();
  ctx.cleanups.push(async () => {
    await database.collection("mealselections").deleteMany({ subscription: sub._id });
    if (meals.length) await database.collection("mealselections").insertMany(meals);
    await database.collection("subscriptions").updateOne({ _id: sub._id }, { $set: { validTill: sub.validTill, shiftsThisCycle: sub.shiftsThisCycle || 0, autoShiftsThisCycle: sub.autoShiftsThisCycle || 0, history: sub.history } });
    await database.collection("users").updateOne({ _id: userId }, { $set: { "subscription.expiresAt": new Date(`${sub.validTill}T23:59:00+05:30`) } });
    await database.collection("notifications").deleteMany({ user: userId, createdAt: { $gte: startedAt } });
  });
  // Meal days: the plan's days only (no Sundays on the demo plans).
  const days = [];
  for (let offset = 1; days.length < 3 && offset < 10; offset += 1) if (sub.planSnapshot.activeDays.includes(weekday(istKey(offset)))) days.push(istKey(offset));
  const [mealDay, shiftDay] = days;

  // ---- Choose Meal Slot
  let lunch = null;
  await s.run("15-01", "Choose Meal Slot: Breakfast / Lunch / Dinner with times and until-when", "Choose Meal Slot (title, time, arrow)", async () => {
    const res = await me.call("GET", `/subscriptions/me/days/${mealDay}`);
    const list = res.data?.meals || [];
    lunch = list.find((m) => m.slot === "lunch");
    return {
      ok: res.status === 200 && DAY.test(res.data.dateLabel) && list.length === 3 && list.every((m) => m.slotName && /^\d{1,2}:\d{2} (AM|PM) – \d{1,2}:\d{2} (AM|PM)$/.test(m.timeLabel) && /^Until \d{1,2}:\d{2} (AM|PM)/.test(m.cutoffLabel) && m.statusLabel && typeof m.editable === "boolean") && lunch?.prepareTitle === `Prepare ${mealDay === istKey(0) ? "Today's" : mealDay === istKey(1) ? "Tomorrow's" : "your"} Lunch`,
      detail: `${res.data?.dateLabel}: ${list.map((m) => `${m.slotName} ${m.timeLabel} (${m.cutoffLabel}, ${m.statusLabel})`).join(" · ")} · “${lunch?.prepareTitle}”`,
    };
  });
  await s.run("15-02", "Upcoming week: seven days with labels and meals", "My meals (week)", async () => {
    const week = (await me.call("GET", "/subscriptions/me/week")).data || [];
    return { ok: week.length === 7 && week.every((d) => DAY.test(d.dateLabel) && Array.isArray(d.meals)) && week.some((d) => d.meals.length === 3), detail: week.map((d) => `${d.dateLabel.slice(0, 3)} ${d.meals.length}`).join(" · ") };
  });

  // ---- Prepare meal (menu)
  let menu = null;
  await s.run("15-03", "Prepare meal: dishes with pictures, category tabs, “up to N items”, no prices", "Prepare Today's Lunch (search, categories, cards, Add +, Items added 0/5)", async () => {
    const res = await me.call("GET", `/subscriptions/me/menu?date=${mealDay}&slot=lunch`);
    menu = res.data || {};
    const dishes = menu.dishes || [];
    const pictures = await Promise.all(dishes.slice(0, 6).map((d) => headOk(d.imageUrl)));
    const catIds = new Set((menu.categories || []).map((c) => c.categoryId));
    return {
      ok: res.status === 200 && dishes.length >= 6 && dishes.every((d) => d.name && d.description && d.imageUrl && d.pricePaise === undefined && catIds.has(d.categoryId)) && pictures.every(Boolean) && menu.categories.length >= 2 && menu.categories.every((c) => c.name && c.count >= 1) && menu.maxItems === sub.planSnapshot.maxItemsPerMeal && menu.limitLabel === `You can add up to ${menu.maxItems} items` && menu.title === lunch?.prepareTitle && /^Until /.test(menu.cutoffLabel),
      detail: `${dishes.length} dishes · tabs ${menu.categories?.map((c) => `${c.name} ${c.count}`).join(", ")} · “${menu.limitLabel}” · ${menu.cutoffLabel}`,
    };
  });
  await s.run("15-04", "Prepare meal: search box and a category tab", "Search for dishes, meals… / category chips", async () => {
    const word = (menu.dishes?.[0]?.name || "").split(" ")[0];
    const found = (await me.call("GET", `/subscriptions/me/menu?date=${mealDay}&slot=lunch&q=${encodeURIComponent(word.toLowerCase())}`)).data?.dishes || [];
    const tab = menu.categories?.[0];
    const inTab = (await me.call("GET", `/subscriptions/me/menu?date=${mealDay}&slot=lunch&categoryId=${tab?.categoryId}`)).data?.dishes || [];
    const nothing = (await me.call("GET", `/subscriptions/me/menu?date=${mealDay}&slot=lunch&q=zzzz`)).data?.dishes || [];
    return { ok: found.length >= 1 && found.every((d) => d.name.toLowerCase().includes(word.toLowerCase()) || d.description.toLowerCase().includes(word.toLowerCase())) && inTab.length === tab?.count && inTab.every((d) => d.categoryId === tab.categoryId) && nothing.length === 0, detail: `“${word}” ${found.length} · tab ${tab?.name} ${inTab.length} · “zzzz” ${nothing.length}` };
  });

  // ---- Save, summary, confirmed, modify
  let saved = null;
  await s.run("15-05", "Confirm your lunch: Meal summary and “Your Lunch Meal is Confirmed!”", "Meal summary → Meal confirmed (date, preparation time, View Today's Meals, Modify Meal (Until …), What's Next?)", async () => {
    const items = menu.dishes.slice(0, 2).map((d) => ({ dishId: d.dishId, qty: 1 }));
    const res = await me.call("PUT", `/subscriptions/me/days/${mealDay}/slots/lunch/selection`, { items });
    saved = res.data || {};
    const pictures = await Promise.all((saved.items || []).map((i) => headOk(i.imageUrl)));
    return {
      ok: res.status === 200 && saved.status === "selected" && saved.statusLabel === "Confirmed" && saved.items?.length === 2 && pictures.every(Boolean) && saved.itemsLabel === "2 items" && DAY.test(saved.dateLabel) && saved.confirmedTitle === "Your Lunch Meal is Confirmed!" && /^Preparation starts at \d{1,2}:\d{2} (AM|PM)$/.test(saved.prepStartsLabel) && /^Until \d{1,2}:\d{2} (AM|PM)/.test(saved.cutoffLabel) && saved.editable === true && saved.steps?.length === 3 && saved.steps.every((x) => x.label && TIME.test(x.timeLabel)),
      detail: `${saved.statusLabel} · ${saved.dateLabel} · ${saved.itemsLabel}: ${saved.items?.map((i) => i.name).join(", ")} · “${saved.confirmedTitle}” · ${saved.prepStartsLabel} · Modify ${saved.cutoffLabel} · ${saved.steps?.map((x) => `${x.label} ${x.timeLabel}`).join(" → ")}`,
    };
  });
  await s.run("15-06", "Modify Meal before the cutoff: the new choice is kept", "Modify Meal / Update", async () => {
    const items = [{ dishId: menu.dishes[2].dishId, qty: 2 }];
    const res = await me.call("PUT", `/subscriptions/me/days/${mealDay}/slots/lunch/selection`, { items });
    const again = (await me.call("GET", `/subscriptions/me/days/${mealDay}/slots/lunch/selection`)).data;
    return { ok: res.status === 200 && again?.items?.length === 1 && again.items[0].dishId === menu.dishes[2].dishId && again.items[0].qty === 2 && again.itemsLabel === "2 items", detail: `${again?.items?.map((i) => `${i.name} ×${i.qty}`).join(", ")} · ${again?.itemsLabel}` };
  });
  await s.run("15-07", "Wrong choices are refused with a clear message", "Add + over the limit, dish not on the menu, nothing chosen, past cutoff, day without a meal", async () => {
    const tooMany = await me.call("PUT", `/subscriptions/me/days/${mealDay}/slots/lunch/selection`, { items: [{ dishId: menu.dishes[0].dishId, qty: menu.maxItems + 1 }] });
    const offMenu = await me.call("PUT", `/subscriptions/me/days/${mealDay}/slots/lunch/selection`, { items: [{ dishId: "5f0000000000000000000001", qty: 1 }] });
    const empty = await me.call("PUT", `/subscriptions/me/days/${mealDay}/slots/lunch/selection`, { items: [] });
    const past = await me.call("PUT", `/subscriptions/me/days/${istKey(-1)}/slots/lunch/selection`, { items: [{ dishId: menu.dishes[0].dishId, qty: 1 }] });
    const sunday = days.length ? (() => { for (let o = 1; o < 9; o += 1) if (weekday(istKey(o)) === 0) return istKey(o); return null; })() : null;
    const off = sunday ? await me.call("PUT", `/subscriptions/me/days/${sunday}/slots/lunch/selection`, { items: [{ dishId: menu.dishes[0].dishId, qty: 1 }] }) : { status: 409, message: "n/a" };
    return {
      ok: tooMany.status === 422 && /up to/.test(tooMany.message) && offMenu.status === 422 && /menu/.test(offMenu.message) && empty.status === 422 && empty.message === "Choose at least one dish" && past.status === 409 && off.status === 409,
      detail: `over ${tooMany.status} “${tooMany.message}” · off menu ${offMenu.status} “${offMenu.message}” · none ${empty.status} “${empty.message}” · yesterday ${past.status} “${past.message}” · Sunday ${off.status} “${off.message}”`,
    };
  });

  // ---- Shift today's meal
  let preview = null;
  await s.run("15-08", "Shift meal confirm: today's date, current end, new delivery date, updated end", "Shift Today's Meal → confirm (Today's meal date, Current subscription end, New meal delivery date, Updated subscription end)", async () => {
    const res = await me.call("GET", `/subscriptions/me/shift-preview?date=${shiftDay}&slot=lunch`);
    preview = res.data || {};
    return {
      ok: res.status === 200 && preview.allowed === true && [preview.dateLabel, preview.currentValidTillLabel, preview.shiftedToLabel, preview.newValidTillLabel].every((x) => DAY.test(x || "")) && preview.slotName === "Lunch" && /–/.test(preview.timeLabel) && /No Lunch will be delivered on/.test(preview.message) && preview.shiftedTo > sub.validTill,
      detail: `${preview.slotName} ${preview.timeLabel} · ${preview.dateLabel} · end ${preview.currentValidTillLabel} → meal on ${preview.shiftedToLabel}, end ${preview.newValidTillLabel} · “${preview.message}” · ${preview.shiftsLeft} shifts left`,
    };
  });
  let shifted = null;
  await s.run("15-09", "Confirm meal shift (two taps): moved once, plan one day longer, success labels", "Confirm meal shift → Meal shifted (Shifted from, Delivery date, Updated subscription end, Previously …)", async () => {
    const [a, b] = await Promise.all([me.call("POST", "/subscriptions/me/shift", { date: shiftDay, slot: "lunch" }), me.call("POST", "/subscriptions/me/shift", { date: shiftDay, slot: "lunch" })]);
    shifted = (a.status === 200 ? a : b).data || {};
    const now = await database.collection("subscriptions").findOne({ _id: sub._id });
    return {
      ok: [a.status, b.status].sort().join() === "200,409" && shifted.shiftedTo === preview.shiftedTo && now.validTill === preview.newValidTill && (now.shiftsThisCycle || 0) === (sub.shiftsThisCycle || 0) + 1 && DAY.test(shifted.shiftedToLabel || "") && DAY.test(shifted.previousValidTillLabel || "") && DAY.test(shifted.validTillLabel || "") && /^\d{2} [A-Z][a-z]{2} \d{4}$/.test(shifted.shiftedFromLabel || "") && /one day longer/.test(shifted.message || ""),
      detail: `taps ${a.status}/${b.status} · from ${shifted.shiftedFromLabel} to ${shifted.shiftedToLabel} · end ${shifted.previousValidTillLabel} → ${shifted.validTillLabel} · “${shifted.message}”`,
    };
  });
  await s.run("15-10", "The extra day serves only the shifted meal; a second slot shares that day", "Plan end after shifting lunch, then dinner", async () => {
    const extra = (await me.call("GET", `/subscriptions/me/days/${shifted.shiftedTo}`)).data;
    const dinner = await me.call("POST", "/subscriptions/me/shift", { date: shiftDay, slot: "dinner" });
    const after = (await me.call("GET", `/subscriptions/me/days/${shifted.shiftedTo}`)).data;
    const now = await database.collection("subscriptions").findOne({ _id: sub._id });
    const day = (await me.call("GET", `/subscriptions/me/days/${shiftDay}`)).data;
    return {
      ok: extra?.meals?.map((m) => m.slot).join() === "lunch" && extra.meals[0].shiftedFrom === shiftDay && dinner.status === 200 && dinner.data.shiftedTo === shifted.shiftedTo && after?.meals?.map((m) => m.slot).sort().join() === "dinner,lunch" && now.validTill === shifted.shiftedTo && day.meals.filter((m) => m.status === "shifted").length === 2 && day.meals.find((m) => m.slot === "lunch")?.statusLabel === "Shifted",
      detail: `extra day ${shifted.shiftedTo}: ${extra?.meals?.map((m) => m.slotName).join(", ")} → after dinner shift: ${after?.meals?.map((m) => m.slotName).join(", ")} · plan end ${now.validTill} · ${shiftDay}: ${day.meals.map((m) => `${m.slotName} ${m.statusLabel}`).join(", ")}`,
    };
  });
  await s.run("15-11", "Non-members, signed out and unknown slots are refused", "Security / validation", async () => {
    const none = await outsider.call("GET", `/subscriptions/me/days/${mealDay}`);
    const anon = await new Client().call("GET", "/subscriptions/me/week");
    const badSlot = await me.call("GET", `/subscriptions/me/menu?date=${mealDay}&slot=brunch`);
    const badDate = await me.call("GET", "/subscriptions/me/days/2026-13-40");
    return { ok: none.status === 404 && /Meal Ji Plus/i.test(none.message) && anon.status === 401 && badSlot.status === 422 && badDate.status === 422, detail: `non-member ${none.status} “${none.message}” · signed out ${anon.status} · slot ${badSlot.status} “${badSlot.message}” · date ${badDate.status}` };
  });
  return s;
}
