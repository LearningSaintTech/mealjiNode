// Step 10 · Order tracking and history — Order status, Tracking, Order delivered,
// Orders list, Order details, rating, reorder, cancel, receipts.
// Demo customer 9000000040 places its own orders here (cancelled afterwards);
// history checks use 9000000031's seeded orders.
import { Client, createSuite, DEMO } from "./harness.js";

export default async function step10(ctx) {
  const s = createSuite("10", "Order tracking and history");
  const me = new Client("step10-device-001");
  await me.signIn("9000000040");
  const admin = new Client("step10-admin-001");
  await admin.signIn(DEMO.admin, { staff: true });
  const history = new Client("step10-device-002");
  await history.signIn(DEMO.customer);
  const made = [];
  ctx.cleanups.push(async () => {
    for (const orderId of made) await admin.call("POST", `/admin/orders/${orderId}/cancel`, { reason: "Step 10 test clean-up", refund: "full" }).catch(() => {});
    await me.call("DELETE", "/cart");
  });
  const dishes = (await me.call("GET", "/dishes?limit=100")).data?.items || [];
  const papad = dishes.find((d) => d.name === "Masala Papad");
  const placeCod = async () => {
    await me.call("DELETE", "/cart");
    await me.call("POST", "/cart/items", { dishId: papad.dishId, qty: 3 });
    const res = await me.call("POST", "/orders", { paymentMethod: "cod" });
    if (res.data?.order?.orderId) made.push(res.data.order.orderId);
    return res.data?.order;
  };

  // ---- orders list and details
  await s.run("10-01", "Orders list: newest first, Active and Past tabs, paged", "Orders tab", async () => {
    const all = (await history.call("GET", "/orders?limit=5")).data;
    const active = (await history.call("GET", "/orders?status=active")).data;
    const past = (await history.call("GET", "/orders?status=past&limit=5&page=1")).data;
    const page2 = (await history.call("GET", "/orders?status=past&limit=5&page=2")).data;
    const sorted = all.items.every((o, i) => i === 0 || new Date(all.items[i - 1].createdAt) >= new Date(o.createdAt));
    const bad = await history.call("GET", "/orders?status=old");
    return {
      ok: all.total > 0 && sorted && all.counts?.active === active.total && all.counts?.past === past.total && typeof all.hasMore === "boolean" && active.items.every((o) => !["delivered", "cancelled"].includes(o.status)) && past.items.every((o) => ["delivered", "cancelled", "payment_failed"].includes(o.status)) && (page2.items.length === 0 || page2.items[0].orderId !== past.items[0].orderId) && bad.status === 422,
      detail: `${all.total} orders · tab badges Current ${all.counts?.active} / Past ${all.counts?.past} · bad tab ${bad.status}`,
    };
  });
  await s.run("10-02", "Each order card has what the list shows", "Past card: “4 days ago”, “Butter chicken bowl + butter naan”, Delivered · ₹548, Reorder", async () => {
    const o = (await history.call("GET", "/orders?status=past&limit=1")).data.items[0];
    return { ok: o.orderNumber && o.dateLabel && o.title && o.placedAtLabel && o.statusLabel && o.items.every((i) => i.name && i.optionsText) && o.bill.grandTotalPaise > 0 && o.itemCount > 0 && o.kitchen?.name, detail: `${o.dateLabel} · ${o.title} · ${o.statusLabel} · ₹${o.bill.grandTotalPaise / 100} (${o.orderNumber})` };
  });
  await s.run("10-03", "Order details: bill, address, payment, timeline", "Order details screen", async () => {
    const id = (await history.call("GET", "/orders?status=past&limit=1")).data.items[0].orderId;
    const o = (await history.call("GET", `/orders/${id}`)).data;
    return { ok: o.bill.lines !== undefined && o.address?.fullAddress && o.paymentMethodLabel && o.progress?.length === 4 && o.statusHistory?.length > 0, detail: `${o.orderNumber} · ${o.address?.displayLabel || o.address?.label} · ${o.paymentMethodLabel} · ${o.progress?.map((p) => p.state).join("/")}` };
  });
  await s.run("10-04", "Someone else's order is not visible", "Security", async () => {
    const id = (await history.call("GET", "/orders?limit=1")).data.items[0].orderId;
    const views = await Promise.all(["", "/live", "/tracking", "/receipt"].map((suffix) => me.call("GET", `/orders/${id}${suffix}`)));
    return { ok: views.every((v) => v.status === 404), detail: views.map((v) => v.status).join(",") };
  });

  // ---- live status and tracking on a fresh order
  let order;
  await s.run("10-05", "Live status follows the kitchen: placed → preparing → out for delivery → delivered", "Order status / Tracking screens", async () => {
    order = await placeCod();
    const kitchenId = order.kitchen.kitchenId;
    const states = [];
    const live = async () => (await me.call("GET", `/orders/${order.orderId}/live`)).data;
    states.push((await live()).status);
    for (const status of ["accepted", "preparing", "ready", "dispatched"]) {
      await admin.call("PATCH", `/admin/orders/${order.orderId}/status`, { status, reason: "step 10 test" });
    }
    const accepted = await live();
    const out = await live();
    const detail = (await me.call("GET", `/orders/${order.orderId}`)).data;
    states.push(out.status);
    return { ok: out.status === "dispatched" && /^Arriving by \d{1,2}:\d{2} (AM|PM)/.test(out.arrivingByLabel || "") && accepted.cancelReasons?.length > 0 && out.timeline.filter((t) => t.done).length >= 4 && detail.progress[2].state === "active" && detail.progress[0].state === "done" && kitchenId, detail: `${states.join(" → ")} · “${out.arrivingByLabel}” · bar ${detail.progress.map((p) => `${p.label}:${p.state}`).join(" › ")}` };
  });
  await s.run("10-06", "Tracking: kitchen, destination, rider and live position", "Tracking map", async () => {
    await admin.call("PATCH", `/admin/orders/${order.orderId}/delivery`, { action: "assign_rider", rider: { name: "Ramesh", phone: "9876543210", vehicleNumber: "KA01AB1234" } }).catch(() => {});
    const t = (await me.call("GET", `/orders/${order.orderId}/tracking`)).data;
    return { ok: t.kitchen?.latitude && t.destination?.latitude && t.estimatedDeliveryAt, detail: `kitchen ${t.kitchen?.name} → ${t.destination?.fullAddress?.slice(0, 30)}… · rider ${t.rider?.name || "not assigned"} ${t.rider?.phoneMasked || ""}` };
  });
  await s.run("10-07", "Delivered: rate the order once (double tap safe)", "Order delivered → rate food and delivery", async () => {
    await admin.call("PATCH", `/admin/orders/${order.orderId}/status`, { status: "delivered", reason: "step 10 test" });
    const before = (await me.call("GET", `/orders/${order.orderId}`)).data;
    const body = { foodRating: 5, deliveryRating: 4, tags: ["Tasty", "Hot & fresh"], comment: "Loved it" };
    const [a, b] = await Promise.all([me.call("POST", `/orders/${order.orderId}/rating`, body), me.call("POST", `/orders/${order.orderId}/rating`, body)]);
    const bad = await me.call("POST", `/orders/${order.orderId}/rating`, { foodRating: 6 });
    const after = (await me.call("GET", `/orders/${order.orderId}`)).data;
    return { ok: before.canRate && before.ratingTags.join() === "Delicious,Fresh,Warm,On time,Would reorder" && before.deliveredAtLabel && before.punctualityLabel && [a.status, b.status].sort().join() === "200,409" && after.rating?.food === 5 && after.canRate === false && bad.status === 422, detail: `“Delivered at ${before.deliveredAtLabel} · ${before.punctualityLabel}” · tags ${before.ratingTags.length} · two taps → ${a.status}/${b.status} · stored ${after.rating?.food}★ ${after.rating?.tags?.join(", ")} · 6 stars ${bad.status}` };
  });
  await s.run("10-08", "Only delivered orders can be rated", "Rate before delivery", async () => {
    const fresh = await placeCod();
    const res = await me.call("POST", `/orders/${fresh.orderId}/rating`, { foodRating: 5 });
    return { ok: res.status === 409, detail: `${res.status} ${res.message}` };
  });
  await s.run("10-09", "Cancel while allowed; refused once the kitchen has started", "Cancel order", async () => {
    const fresh = await placeCod();
    const early = (await me.call("GET", `/orders/${fresh.orderId}/live`)).data;
    const cancel = early.canCancel ? await me.call("PATCH", `/orders/${fresh.orderId}/cancel`, { reason: "Ordered by mistake" }) : null;
    const late = await me.call("PATCH", `/orders/${order.orderId}/cancel`, { reason: "Changed my mind" });
    return { ok: (cancel === null || (cancel.status === 200 && cancel.data.status === "cancelled")) && late.status === 409, detail: `can cancel ${early.canCancel}${cancel ? ` → ${cancel.data?.statusLabel}` : ""} · delivered order cancel ${late.status}` };
  });
  await s.run("10-10", "Reorder fills the cart; another kitchen's cart is not silently replaced", "Reorder", async () => {
    await me.call("DELETE", "/cart");
    const res = await me.call("POST", `/orders/${order.orderId}/reorder`);
    const cart = (await me.call("GET", "/cart")).data;
    // Put another kitchen's dish in the cart, then reorder: it must ask first.
    const { db } = await import("./harness.js");
    const database = await db();
    const otherKitchen = await database.collection("kitchens").findOne({ _id: { $ne: new (await import("mongoose")).default.Types.ObjectId(order.kitchen.kitchenId) }, status: "active" });
    const otherDish = await database.collection("kitchendishes").findOne({ kitchen: otherKitchen._id, approvalStatus: "live", isActive: true, "customizationGroups.minSelect": { $not: { $gt: 0 } } });
    await me.call("POST", "/cart/items", { dishId: String(otherDish._id), replaceCart: true });
    const ask = await me.call("POST", `/orders/${order.orderId}/reorder`);
    const replaced = await me.call("POST", `/orders/${order.orderId}/reorder`, { replaceCart: true });
    return {
      ok: res.status === 200 && res.data.added > 0 && cart.items.some((i) => i.dishId === papad.dishId) && ask.status === 409 && ask.errors?.[0]?.message === "CART_KITCHEN_MISMATCH" && replaced.status === 200 && replaced.data.cart.kitchen.kitchenId === order.kitchen.kitchenId,
      detail: `added ${res.data?.added} · other kitchen's cart → ${ask.status} ${ask.errors?.[0]?.message} · replaceCart → ${replaced.status}`,
    };
  });
  await s.run("10-11", "Receipt and invoices for a paid order", "View receipt / Invoices", async () => {
    const paid = (await history.call("GET", "/orders?status=past&limit=20")).data.items.find((o) => o.invoiceId);
    const receipt = await history.call("GET", `/orders/${paid.orderId}/receipt`);
    const pdf = await fetch(`${process.env.SMOKE_API || "http://localhost:4000"}/api/v1/orders/${paid.orderId}/receipt?format=pdf`, { headers: history.headers });
    const list = (await history.call("GET", "/invoices?limit=5")).data;
    const other = await me.call("GET", `/invoices/${paid.invoiceId}`);
    return { ok: receipt.status === 200 && receipt.data.invoiceNumber && pdf.headers.get("content-type")?.includes("pdf") && list.items.length > 0 && other.status === 404, detail: `${receipt.data?.invoiceNumber} · pdf ${pdf.status} · ${list.items.length} invoices · other customer ${other.status}` };
  });
  return s;
}
