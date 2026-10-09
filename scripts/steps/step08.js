// Step 08 · Cart and checkout — Cart, Checkout (bill summary), Offers.
// Uses demo customer 9000000033 so other steps' carts are not disturbed; the
// cart, addresses and kitchen switches it changes are put back.
import { Client, createSuite, db, POINTS } from "./harness.js";

const CUSTOMER = "9000000033";
const sumRows = (rows) => rows.filter((row) => !row.isTotal).reduce((sum, row) => sum + row.amountPaise, 0);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function step08(ctx) {
  const s = createSuite("08", "Cart and checkout");
  const me = new Client("step08-device-001");
  await me.signIn(CUSTOMER);
  await me.call("DELETE", "/cart");
  ctx.cleanups.push(() => me.call("DELETE", "/cart"));
  const dishes = (await me.call("GET", "/dishes?limit=100")).data?.items || [];
  const byName = (name) => dishes.find((dish) => dish.name === name);
  const bowl = byName("Butter Chicken Bowl");
  const detail = (await me.call("GET", `/menu/items/${bowl.dishId}`)).data;
  const rice = detail.customizationGroups.find((group) => group.required);
  const side = detail.customizationGroups.find((group) => !group.required);
  const papad = byName("Masala Papad");
  const naan = byName("Butter Naan");

  await s.run("08-01", "Empty cart says so and cannot check out", "Cart: empty state", async () => {
    const res = await me.call("GET", "/cart");
    const anon = await new Client("step08-anon").call("GET", "/cart");
    return { ok: res.status === 200 && res.data.items.length === 0 && res.data.canCheckout === false && res.data.blockers[0]?.code === "EMPTY" && anon.status === 401, detail: `${res.data?.blockers?.[0]?.message} · no token ${anon.status}` };
  });
  let bowlLine;
  await s.run("08-02", "Add a dish with portion, options and meal: price adds up", "Dish detail → Add to cart; cart line “Large • … • + Complete Meal”", async () => {
    const body = { dishId: bowl.dishId, portionId: "large", optionIds: [rice.options[1].optionId, side.options[0].optionId], mealUpgrade: true };
    const res = await me.call("POST", "/cart/items", body);
    bowlLine = res.data?.items?.find((line) => line.dishId === bowl.dishId);
    const portion = detail.portions.find((p) => p.portionId === "large").pricePaise;
    const expected = portion + rice.options[1].pricePaise + side.options[0].pricePaise + detail.mealUpgrade.pricePaise;
    return {
      ok: res.status === 201 && bowlLine?.unitPricePaise === expected && bowlLine.totalPaise === expected && bowlLine.optionsText.startsWith("Large") && bowlLine.optionsText.includes("Complete Meal") && bowlLine.imageUrl && typeof bowlLine.isVeg === "boolean",
      detail: `${bowlLine?.optionsText} = ₹${bowlLine?.unitPricePaise / 100} (expected ₹${expected / 100})`,
    };
  });
  await s.run("08-03", "Wrong choices are refused clearly", "Required option missing, bad portion, unknown dish", async () => {
    const noRice = await me.call("POST", "/cart/items", { dishId: bowl.dishId });
    const badPortion = await me.call("POST", "/cart/items", { dishId: bowl.dishId, portionId: "huge", optionIds: [rice.options[0].optionId] });
    const unknown = await me.call("POST", "/cart/items", { dishId: "000000000000000000000000" });
    const both = await me.call("POST", "/cart/items", { dishId: bowl.dishId, comboId: bowl.dishId });
    return { ok: noRice.status === 422 && noRice.errors?.[0]?.field === "optionIds" && badPortion.status === 422 && unknown.status === 404 && both.status === 422, detail: `${noRice.status} “${noRice.errors?.[0]?.message}” / ${badPortion.status} / ${unknown.status} / ${both.status}` };
  });
  await s.run("08-04", "Same dish and choices again is one line; different choices a new line", "Tapping Add twice", async () => {
    await me.call("POST", "/cart/items", { dishId: papad.dishId });
    const again = await me.call("POST", "/cart/items", { dishId: papad.dishId });
    const lines = again.data.items.filter((line) => line.dishId === papad.dishId);
    return { ok: lines.length === 1 && lines[0].qty === 2 && again.data.items.filter((line) => line.dishId === bowl.dishId).length === 1, detail: `papad lines ${lines.length} qty ${lines[0]?.qty}` };
  });
  await s.run("08-05", "Fast taps on + never lose an item", "Quantity stepper tapped quickly", async () => {
    const taps = await Promise.all(Array.from({ length: 8 }, () => me.call("POST", "/cart/items", { dishId: naan.dishId })));
    const line = (await me.call("GET", "/cart")).data.items.find((item) => item.dishId === naan.dishId);
    return { ok: taps.every((tap) => tap.status === 201) && line?.qty === 8, detail: `8 parallel adds → qty ${line?.qty}` };
  });
  await s.run("08-06", "Change quantity, remove at 0, refuse bad values", "Stepper − / + and remove", async () => {
    const naanLine = (await me.call("GET", "/cart")).data.items.find((item) => item.dishId === naan.dishId);
    const two = await me.call("PATCH", `/cart/items/${naanLine.lineId}`, { qty: 2 });
    const tooMany = await me.call("PATCH", `/cart/items/${naanLine.lineId}`, { qty: 51 });
    const zero = await me.call("PATCH", `/cart/items/${naanLine.lineId}`, { qty: 0 });
    const missing = await me.call("PATCH", "/cart/items/abcdef123456", { qty: 1 });
    return { ok: two.data.items.find((i) => i.lineId === naanLine.lineId)?.qty === 2 && tooMany.status === 422 && !zero.data.items.some((i) => i.lineId === naanLine.lineId) && missing.status === 404, detail: `2 → ok, 51 → ${tooMany.status}, 0 → removed, unknown → ${missing.status}` };
  });
  await s.run("08-07", "Changing a line's options to match another merges them", "Cart: Customize", async () => {
    const first = (await me.call("POST", "/cart/items", { dishId: bowl.dishId, optionIds: [rice.options[0].optionId] })).data.items;
    const plain = first.find((line) => line.dishId === bowl.dishId && line.optionsText.endsWith(rice.options[0].name));
    const second = await me.call("POST", "/cart/items", { dishId: bowl.dishId, optionIds: [rice.options[2].optionId] });
    const other = second.data.items.find((line) => line.dishId === bowl.dishId && line.optionsText.endsWith(rice.options[2].name));
    const merged = await me.call("PATCH", `/cart/items/${other.lineId}`, { optionIds: [rice.options[0].optionId] });
    const after = merged.data.items.filter((line) => line.dishId === bowl.dishId && line.optionsText.endsWith(rice.options[0].name));
    const badPortion = await me.call("PATCH", `/cart/items/${plain.lineId}`, { portionId: "huge" });
    await me.call("PATCH", `/cart/items/${after[0]?.lineId}`, { qty: 0 });
    return { ok: after.length === 1 && after[0].qty === 2 && badPortion.status === 422, detail: `merged qty ${after[0]?.qty} · bad portion ${badPortion.status}` };
  });
  await s.run("08-08", "Items from another kitchen ask to replace the cart", "Cart from a different kitchen", async () => {
    const database = await db();
    const indiranagar = await database.collection("kitchens").findOne({ phoneNumber: "9000000021" });
    const other = await database.collection("kitchendishes").findOne({ kitchen: indiranagar._id, approvalStatus: "live", isActive: true, customizationGroups: { $size: 0 }, availableSlots: { $size: 0 } })
      || await database.collection("kitchendishes").findOne({ kitchen: indiranagar._id, approvalStatus: "live", isActive: true, "customizationGroups.0": { $exists: false } });
    const clash = await me.call("POST", "/cart/items", { dishId: String(other._id) });
    return { ok: clash.status === 409 && clash.errors?.[0]?.message === "CART_KITCHEN_MISMATCH", detail: `${clash.status} ${clash.message}` };
  });
  await s.run("08-09", "Combos go in the cart at the combo price", "Combos → Add", async () => {
    const combo = (await me.call("GET", "/combos")).data.find((item) => item.isAvailable);
    const res = await me.call("POST", "/cart/items", { comboId: combo.comboId });
    const line = res.data.items.find((item) => item.comboId === combo.comboId);
    return { ok: res.status === 201 && line?.unitPricePaise === combo.pricePaise && line.kind === "combo", detail: `${combo.name} ₹${line?.unitPricePaise / 100}` };
  });

  const cart = (await me.call("GET", "/cart")).data;
  await s.run("08-10", "Bill rows add up to the total, with GST", "Bill details: Item total (n items), Delivery fee, Packaging, Taxes (GST), Total amount", () => ({
    ok: sumRows(cart.billLines) === cart.bill.grandTotalPaise && cart.billLines.at(-1).isTotal && cart.billLines.some((row) => row.key === "taxes") && cart.billLines[0].label.startsWith("Item total ("),
    detail: cart.billLines.map((row) => `${row.label} ${row.text || (row.amountPaise / 100).toFixed(2)}`).join(" | "),
  }));
  await s.run("08-11", "Header, savings and line texts are ready to show", "“Meal Ji • 26 min delivery”, “You're saving ₹X on this order!”, options line", () => ({
    ok: cart.kitchen?.name && /\d+ min/.test(cart.etaLabel) && (cart.bill.savingsPaise === 0 || cart.savingsMessage?.includes("saving")) && cart.items.every((line) => line.optionsText),
    detail: `${cart.kitchen?.name} • ${cart.etaLabel} · ${cart.savingsMessage}`,
  }));
  await s.run("08-12", "Free delivery from ₹299 up; “₹X more” matches Home; Plus members never see it", "Unlock Free delivery / Shop For ₹X more", async () => {
    // A customer without Meal Ji Plus.
    const guest = new Client("step08-device-003");
    await guest.signIn("9000000035");
    await guest.call("DELETE", "/cart");
    ctx.cleanups.push(() => guest.call("DELETE", "/cart"));
    const small = (await guest.call("POST", "/cart/items", { dishId: papad.dishId })).data;
    const home = (await guest.call("GET", "/home")).data.cart;
    const row = small.billLines.find((item) => item.key === "delivery");
    const big = (await guest.call("PATCH", `/cart/items/${small.items[0].lineId}`, { qty: Math.ceil(small.bill.freeDeliveryAbovePaise / papad.pricePaise) })).data;
    // This test's customer has Meal Ji Plus: delivery is free, nothing “more” to add.
    await me.call("DELETE", "/cart");
    const member = (await me.call("POST", "/cart/items", { dishId: papad.dishId })).data;
    const memberHome = (await me.call("GET", "/home")).data.cart;
    return {
      ok: small.bill.deliveryFeePaise > 0 && small.bill.amountToFreeDeliveryPaise === small.bill.freeDeliveryAbovePaise - small.bill.itemTotalPaise && home.amountToFreeDeliveryPaise === small.bill.amountToFreeDeliveryPaise && small.freeDeliveryMessage && row?.amountPaise > 0 && big.bill.deliveryFeeWaived === true
        && member.bill.deliveryFeeWaived && member.freeDeliveryMessage === null && memberHome.amountToFreeDeliveryPaise === 0,
      detail: `guest: “${small.freeDeliveryMessage}” (home ₹${home.amountToFreeDeliveryPaise / 100}), at ₹${big.bill.itemTotalPaise / 100} delivery ${big.billLines.find((item) => item.key === "delivery")?.text} · Plus member: delivery ${member.billLines.find((item) => item.key === "delivery")?.text}, message ${member.freeDeliveryMessage}, home ₹${memberHome.amountToFreeDeliveryPaise}`,
    };
  });

  // ---- offers
  await s.run("08-13", "Offers list: code, title, label, terms, can I use it", "Apply promo code → offers sheet", async () => {
    const res = await me.call("GET", "/promos/available");
    const list = res.data || [];
    const firstNo = list.findIndex((offer) => !offer.applicable);
    return { ok: res.status === 200 && list.length > 0 && list.every((o) => o.code && o.title && o.label && typeof o.applicable === "boolean" && "minOrderPaise" in o) && (firstNo === -1 || list.slice(firstNo).every((o) => !o.applicable)), detail: list.map((o) => `${o.code}${o.applicable ? "" : "×"}`).join(" ") };
  });
  await s.run("08-14", "Apply an offer: discount row, lower total; remove it again", "Apply / Remove", async () => {
    await me.call("POST", "/cart/items", { dishId: bowl.dishId, qty: 2, optionIds: [rice.options[0].optionId] }); // ~₹700 so offers apply
    const before = (await me.call("GET", "/cart")).data;
    const offer = (await me.call("GET", "/promos/available")).data.find((o) => o.applicable && o.type !== "free_delivery");
    const applied = await me.call("POST", "/cart/promo", { code: offer.code.toLowerCase() });
    const removed = await me.call("DELETE", "/cart/promo");
    const row = applied.data?.billLines?.find((item) => item.key === "discount");
    return { ok: applied.status === 200 && row?.amountPaise < 0 && applied.data.bill.grandTotalPaise < before.bill.grandTotalPaise && sumRows(applied.data.billLines) === applied.data.bill.grandTotalPaise && removed.data.coupon === null, detail: `${offer.code}: ${row?.label} ${row?.amountPaise / 100} · total ₹${before.bill.grandTotalPaise / 100} → ₹${applied.data?.bill.grandTotalPaise / 100}` };
  });
  await s.run("08-15", "Wrong or too-small offers explain why", "Invalid code / add more to use this offer", async () => {
    const bad = await me.call("POST", "/cart/promo", { code: "NOPE123" });
    const tooBig = (await me.call("GET", "/promos/available")).data.find((o) => !o.applicable && o.shortByPaise > 0);
    const short = tooBig ? await me.call("POST", "/cart/promo", { code: tooBig.code }) : null;
    return { ok: bad.status === 422 && bad.message && (!tooBig || (short.status === 422 && /add more/i.test(short.message))), detail: `${bad.message} · ${tooBig ? `${tooBig.code}: ${short.message} (₹${tooBig.shortByPaise / 100} short)` : "no min-order offer"}` };
  });
  await s.run("08-16", "“Add a few more favorites?” suggestions", "Cart recommendations with +", async () => {
    const res = await me.call("GET", "/cart/recommendations");
    const inCart = new Set((await me.call("GET", "/cart")).data.items.map((line) => line.dishId));
    return { ok: res.status === 200 && res.data.length > 0 && res.data.every((d) => !inCart.has(d.dishId) && d.pricePaise > 0 && typeof d.isFavorite === "boolean"), detail: res.data.map((d) => d.name).join(", ") };
  });

  // ---- checkout
  await s.run("08-17", "Delivery address: the default is picked; another can be chosen", "Checkout: Delivery Address card", async () => {
    const auto = (await me.call("GET", "/cart")).data;
    const list = (await me.call("GET", "/users/me/addresses")).data;
    const made = await me.call("POST", "/users/me/addresses", { label: "Office", houseFlat: "2nd Floor, Forum Mall", city: "Bengaluru", pincode: "560095", latitude: 12.9345, longitude: 77.6112 });
    ctx.cleanups.push(() => me.call("DELETE", `/users/me/addresses/${made.data?.addressId}`));
    const chosen = await me.call("PATCH", "/cart", { addressId: made.data?.addressId });
    const foreign = await me.call("PATCH", "/cart", { addressId: "000000000000000000000000" });
    await me.call("PATCH", "/cart", { addressId: null });
    return { ok: auto.address?.addressId === list.find((a) => a.isDefault)?.addressId && chosen.data?.address?.addressId === made.data?.addressId && foreign.status === 404, detail: `default ${auto.address?.displayLabel} · chosen ${chosen.data?.address?.displayLabel} · not mine ${foreign.status}` };
  });
  await s.run("08-18", "An address the kitchen does not reach blocks checkout", "Checkout: address not serviceable", async () => {
    const far = await me.call("POST", "/users/me/addresses", { label: "Other", customLabel: "Airport", houseFlat: "Terminal 1", city: "Bengaluru", pincode: "560300", ...POINTS.notServed });
    ctx.cleanups.push(() => me.call("DELETE", `/users/me/addresses/${far.data?.addressId}`));
    const res = await me.call("POST", "/checkout/summary", { addressId: far.data?.addressId });
    return { ok: res.data?.canCheckout === false && res.data.blockers.some((b) => b.code === "ADDRESS_NOT_SERVICEABLE"), detail: res.data?.blockers.map((b) => b.message).join(" | ") };
  });
  await s.run("08-19", "Tip and points change the total", "Tip for your rider (₹20/₹30/₹50), use Meal Ji points", async () => {
    const base = (await me.call("GET", "/cart")).data;
    const tip = base.tip.presetsPaise[0];
    const withTip = (await me.call("PATCH", "/cart", { tipPaise: tip })).data;
    const withPoints = (await me.call("PATCH", "/cart", { usePoints: true })).data;
    const tooMuch = await me.call("PATCH", "/cart", { tipPaise: 1_000_000 });
    await me.call("PATCH", "/cart", { tipPaise: 0, usePoints: false });
    const pointsRow = withPoints.billLines.find((row) => row.key === "points");
    return {
      ok: base.tip.enabled && withTip.bill.grandTotalPaise === base.bill.grandTotalPaise + tip && withTip.billLines.some((row) => row.key === "tip") && (!withPoints.points.usable || (pointsRow?.amountPaise < 0 && withPoints.points.usedPoints <= withPoints.points.usable)) && tooMuch.status === 422,
      detail: `presets ${base.tip.presetsPaise.map((p) => p / 100).join("/")} · tip +₹${tip / 100} · points ${withPoints.points.usedPoints} used (−₹${-(pointsRow?.amountPaise || 0) / 100}) · huge tip ${tooMuch.status}`,
    };
  });
  await s.run("08-20", "Deliver now or schedule for later", "Checkout: Standard Delivery “26 min (Today)” / Schedule for later", async () => {
    const slots = (await me.call("GET", "/delivery/slots")).data;
    const pick = slots.scheduled[0];
    const set = pick ? await me.call("PATCH", "/cart", { scheduledFor: pick.startsAt }) : null;
    const bad = await me.call("PATCH", "/cart", { scheduledFor: "2026-01-01T03:17:00.000Z" });
    const back = await me.call("PATCH", "/cart", { scheduledFor: null });
    return {
      ok: slots.options[0].type === "asap" && slots.scheduledEnabled && slots.scheduled.length > 0 && set?.data?.delivery?.type === "scheduled" && bad.status === 422 && back.data?.delivery?.type === "asap" && /min \(Today\)/.test(back.data.delivery.label),
      detail: `${slots.scheduled.length} slots, e.g. “${pick?.label}” · chosen ${set?.data?.delivery?.label} · bad time ${bad.status} · now “${back.data?.delivery?.label}”`,
    };
  });
  await s.run("08-21", "Payment choices in the app's words; summary never saves", "Checkout: Payment Method list", async () => {
    const before = (await me.call("GET", "/cart")).data;
    const summary = await me.call("POST", "/checkout/summary", { paymentMethod: "cod", tipPaise: 5000 });
    const after = (await me.call("GET", "/cart")).data;
    const methods = summary.data?.paymentMethods || [];
    return { ok: summary.status === 200 && methods.find((m) => m.method === "upi")?.label === "UPI (Recommended)" && methods.every((m) => m.label && m.description && typeof m.enabled === "boolean") && after.tipPaise === before.tipPaise, detail: methods.map((m) => `${m.label}${m.enabled ? "" : " (off)"}`).join(" | ") };
  });
  await s.run("08-22", "Special instructions are kept (max 300 characters)", "“E.g. no onion, less spicy, extra gravy...”", async () => {
    const ok1 = await me.call("PATCH", "/cart", { chefNote: "No onion, less spicy" });
    const tooLong = await me.call("PATCH", "/cart", { chefNote: "x".repeat(301) });
    return { ok: ok1.data?.chefNote === "No onion, less spicy" && tooLong.status === 422, detail: `${ok1.data?.chefNote} · 301 chars ${tooLong.status}` };
  });
  await s.run("08-23", "Pickup (off at this kitchen) is explained", "Delivery / Pickup", async () => {
    const res = await me.call("POST", "/checkout/summary", { deliveryMode: "pickup" });
    const off = res.data?.blockers?.some((b) => b.code === "PICKUP_DISABLED");
    return { ok: res.status === 200 && (off || res.data.canCheckout) && res.data.bill.deliveryFeePaise === 0, detail: off ? "Pickup is not available at this kitchen" : `pickup ok, ${res.data?.etaLabel}` };
  });
  await s.run("08-24", "A paused kitchen blocks checkout with a message", "Kitchen closed / paused", async () => {
    const database = await db();
    const kitchenId = new (await import("mongoose")).default.Types.ObjectId(cart.kitchen.kitchenId);
    await database.collection("kitchens").updateOne({ _id: kitchenId }, { $set: { acceptingOrders: false } });
    ctx.cleanups.push(() => database.collection("kitchens").updateOne({ _id: kitchenId }, { $set: { acceptingOrders: true } }));
    await wait(6000); // the API keeps active kitchens in memory for 5 s
    const res = (await me.call("GET", "/cart")).data;
    await database.collection("kitchens").updateOne({ _id: kitchenId }, { $set: { acceptingOrders: true } });
    await wait(6000);
    const blocker = res.blockers.find((b) => b.code === "KITCHEN_CLOSED");
    return { ok: res.canCheckout === false && blocker?.message, detail: blocker?.message };
  });
  await s.run("08-25", "Another customer cannot touch my cart lines", "Security", async () => {
    const mine = (await me.call("GET", "/cart")).data.items[0];
    const other = new Client("step08-device-002");
    await other.signIn("9000000034");
    const res = await other.call("PATCH", `/cart/items/${mine.lineId}`, { qty: 5 });
    const still = (await me.call("GET", "/cart")).data.items.find((line) => line.lineId === mine.lineId);
    return { ok: res.status === 404 && still?.qty === mine.qty, detail: `${res.status}, my qty still ${still?.qty}` };
  });
  return s;
}
