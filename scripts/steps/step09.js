// Step 09 · Place order and pay — Pay ₹X, payment (test gateway), Order confirmed,
// saved payment methods. Demo customers 9000000037/38; every order made here is
// cancelled (and refunded) by the admin API afterwards.
import { Client, createSuite, DEMO } from "./harness.js";

const CUSTOMER = "9000000037";

export default async function step09(ctx) {
  const s = createSuite("09", "Place order and pay");
  const me = new Client("step09-device-001");
  await me.signIn(CUSTOMER);
  const admin = new Client("step09-admin-001");
  await admin.signIn(DEMO.admin, { staff: true });
  const made = [];
  ctx.cleanups.push(async () => {
    for (const orderId of made) await admin.call("POST", `/admin/orders/${orderId}/cancel`, { reason: "Step 09 test clean-up", refund: "full" }).catch(() => {});
    await me.call("DELETE", "/cart");
  });
  const dishes = (await me.call("GET", "/dishes?limit=100")).data?.items || [];
  const papad = dishes.find((d) => d.name === "Masala Papad");
  const fries = dishes.find((d) => d.name === "Masala Gunpowder Fries");
  const fill = async (qty = 4) => {
    await me.call("DELETE", "/cart");
    await me.call("POST", "/cart/items", { dishId: papad.dishId, qty });
    await me.call("POST", "/cart/items", { dishId: fries.dishId, qty: 1 });
    return (await me.call("GET", "/cart")).data;
  };
  const place = async (body, headers) => {
    const res = await me.call("POST", "/orders", body, { headers });
    if (res.data?.order?.orderId) made.push(res.data.order.orderId);
    return res;
  };

  let cod;
  await s.run("09-01", "Cash on delivery: order placed at once, cart emptied", "Pay ₹X with Cash on Delivery → Order confirmed", async () => {
    const cart = await fill();
    cod = await place({ paymentMethod: "cod" });
    const after = (await me.call("GET", "/cart")).data;
    const o = cod.data?.order;
    return { ok: cod.status === 201 && ["placed", "accepted"].includes(o?.status) && o.paymentStatus === "cod_pending" && o.bill.grandTotalPaise === cart.bill.grandTotalPaise && o.amountDueOnDeliveryPaise === cart.bill.grandTotalPaise && cod.data.payment === null && after.items.length === 0, detail: `${o?.orderNumber} ${o?.statusLabel} · due ₹${o?.amountDueOnDeliveryPaise / 100} · cart ${after.items.length}` };
  });
  let upi;
  await s.run("09-02", "Online payment: order waits for payment and returns checkout details", "Pay ₹X with UPI → open the payment sheet", async () => {
    const cart = await fill(3);
    upi = await place({ paymentMethod: "upi" });
    const p = upi.data?.payment;
    return { ok: upi.status === 201 && upi.data.order.status === "payment_pending" && p?.gatewayOrderId && p.keyId && p.amountPaise === cart.bill.grandTotalPaise && p.currency === "INR" && p.prefill?.contact && p.description, detail: `${upi.data?.order?.orderNumber} ${upi.data?.order?.statusLabel} · ${p?.gateway} ${p?.gatewayOrderId} ₹${p?.amountPaise / 100}` };
  });
  await s.run("09-03", "Paying confirms the order, the receipt is issued", "Payment success → Order confirmed, View receipt", async () => {
    const paid = await me.call("POST", "/payments/test/complete", { gatewayOrderId: upi.data.payment.gatewayOrderId });
    const again = await me.call("POST", "/payments/verify", { gatewayOrderId: paid.data.gatewayOrderId, gatewayPaymentId: paid.data.gatewayPaymentId, signature: paid.data.signature });
    const order = (await me.call("GET", `/orders/${upi.data.order.orderId}`)).data;
    const receipt = await me.call("GET", `/orders/${upi.data.order.orderId}/receipt`);
    return { ok: paid.data?.verified?.status === "captured" && again.status === 200 && ["placed", "accepted"].includes(order.status) && order.paymentStatus === "paid" && order.amountPaidPaise === order.bill.grandTotalPaise && receipt.status === 200 && receipt.data?.invoiceNumber, detail: `${order.statusLabel} · paid ₹${order.amountPaidPaise / 100} · receipt ${receipt.data?.invoiceNumber} · verify twice ${again.status}` };
  });
  await s.run("09-04", "A wrong signature or someone else's payment is refused", "Security: verify", async () => {
    const cartReady = await fill(2);
    const order = await place({ paymentMethod: "upi" });
    const bad = await me.call("POST", "/payments/verify", { gatewayOrderId: order.data.payment.gatewayOrderId, gatewayPaymentId: "pay_fake_123456", signature: "0".repeat(64) });
    const other = new Client("step09-device-002");
    await other.signIn("9000000038");
    const foreign = await other.call("POST", "/payments/verify", { gatewayOrderId: order.data.payment.gatewayOrderId, gatewayPaymentId: "pay_fake_123456", signature: "0".repeat(64) });
    const peek = await other.call("GET", `/orders/${order.data.order.orderId}`);
    return { ok: cartReady.items.length > 0 && bad.status === 400 && foreign.status === 404 && peek.status === 404, detail: `bad signature ${bad.status} · other customer verify ${foreign.status} · other customer view ${peek.status}` };
  });
  await s.run("09-05", "Payment failed → retry works; an old checkout paid later is refunded", "Payment failed / Retry payment (no double charge)", async () => {
    await fill(2);
    const order = await place({ paymentMethod: "upi" });
    const first = order.data.payment.gatewayOrderId;
    const failed = await me.call("POST", "/payments/failed", { gatewayOrderId: first, reason: "Cancelled by customer" });
    const retry = await me.call("POST", `/orders/${order.data.order.orderId}/retry-payment`);
    const second = retry.data?.payment?.gatewayOrderId;
    await me.call("POST", "/payments/test/complete", { gatewayOrderId: second });
    // The first checkout completes late (customer paid twice).
    await me.call("POST", "/payments/test/complete", { gatewayOrderId: first });
    const view = (await admin.call("GET", `/admin/orders/${order.data.order.orderId}`)).data;
    const refunds = (await admin.call("GET", "/admin/refunds?limit=50")).data?.items || [];
    const refund = refunds.find((r) => r.orderId === order.data.order.orderId && /Duplicate/.test(r.reason));
    return { ok: failed.status === 200 && retry.status === 200 && second && second !== first && view.paymentStatus === "paid" && refund?.status === "processed" && refund.amountPaise === order.data.payment.amountPaise, detail: `retry ${retry.status} · order ${view.paymentStatus} · duplicate refund ${refund?.status} ₹${(refund?.amountPaise || 0) / 100}` };
  });
  await s.run("09-06", "Double tap on Pay makes one order; the same Idempotency-Key replays it", "Pay pressed twice", async () => {
    await fill(2);
    const taps = await Promise.all([1, 2, 3].map(() => place({ paymentMethod: "cod" })));
    const created = taps.filter((t) => t.status === 201);
    const blocked = taps.filter((t) => t.status === 409);
    await fill(2);
    const key = `step09-${Date.now()}`;
    const a = await place({ paymentMethod: "cod" }, { "Idempotency-Key": key });
    const b = await me.call("POST", "/orders", { paymentMethod: "cod" }, { headers: { "Idempotency-Key": key } });
    return { ok: created.length === 1 && blocked.length === 2 && blocked.every((t) => t.errors?.[0]?.message === "ORDER_IN_PROGRESS" || /empty|nothing/i.test(t.message)) && a.status === 201 && b.status === 201 && b.data?.order?.orderId === a.data?.order?.orderId, detail: `3 taps → ${taps.map((t) => t.status).join(",")} · same key → same order ${b.data?.order?.orderNumber === a.data?.order?.orderNumber}` };
  });
  await s.run("09-07", "Nothing to order or a blocked cart is refused with the reason", "Empty cart / not deliverable", async () => {
    await me.call("DELETE", "/cart");
    const empty = await place({ paymentMethod: "cod" });
    await fill(1);
    const badMethod = await place({ paymentMethod: "bitcoin" });
    return { ok: empty.status === 409 && empty.errors?.some((e) => e.message === "EMPTY") && badMethod.status === 422, detail: `empty ${empty.status} “${empty.message}” · unknown method ${badMethod.status}` };
  });
  await s.run("09-08", "Offer and points are carried into the order", "Order total with coupon and points", async () => {
    await fill(6);
    const offer = (await me.call("GET", "/promos/available")).data.find((o) => o.applicable && o.type !== "free_delivery" && !o.paymentMethods?.length);
    if (offer) await me.call("POST", "/cart/promo", { code: offer.code });
    await me.call("PATCH", "/cart", { usePoints: true });
    const cart = (await me.call("GET", "/cart")).data;
    const res = await place({ paymentMethod: "cod" });
    const o = res.data?.order;
    return { ok: res.status === 201 && o.bill.grandTotalPaise === cart.bill.grandTotalPaise && (!offer || (o.couponCode === offer.code && o.bill.discountPaise > 0)) && o.pointsUsed === cart.points.usedPoints, detail: `${o?.orderNumber}: coupon ${o?.couponCode} −₹${(o?.bill.discountPaise || 0) / 100}, points ${o?.pointsUsed}, total ₹${o?.bill.grandTotalPaise / 100}` };
  });
  await s.run("09-09", "Scheduled order keeps the chosen slot", "Schedule for later → Order confirmed shows the time", async () => {
    await fill(2);
    const slot = (await me.call("GET", "/delivery/slots")).data.scheduled[2];
    await me.call("PATCH", "/cart", { scheduledFor: slot.startsAt });
    // A time that was never offered is refused, even when sent with the order.
    const made_up = await place({ paymentMethod: "cod", scheduledFor: "2030-01-01T00:00:00.000Z" });
    const res = await place({ paymentMethod: "cod" });
    const o = res.data?.order;
    return { ok: made_up.status === 409 && made_up.errors?.some((e) => e.message === "SLOT_UNAVAILABLE") && res.status === 201 && new Date(o.scheduledFor).getTime() === new Date(slot.startsAt).getTime() && new Date(o.estimatedDeliveryAt).getTime() === new Date(slot.startsAt).getTime() && /^Scheduled for/.test(o.etaLabel), detail: `made-up time ${made_up.status} · ${slot.label} → ${o?.etaLabel}` };
  });
  await s.run("09-10", "Order confirmed screen has everything it shows", "“Your order is confirmed!”, Order #MJ… Placed on …, Estimated delivery, 4-step bar, items, Total paid", async () => {
    const o = (await me.call("GET", `/orders/${upi.data.order.orderId}`)).data;
    return {
      ok: o.orderNumber?.startsWith("MJ-") && /\d{4}, \d{1,2}:\d{2} (AM|PM)/.test(o.placedAtLabel) && o.etaLabel && o.progress?.length === 4 && o.progress[0].state === "done" && o.items.every((i) => i.name && i.optionsText && i.imageUrl && i.qty) && o.paymentMethodLabel === "UPI" && o.amountPaidPaise > 0,
      detail: `${o.orderNumber} · ${o.placedAtLabel} · ${o.etaLabel} · ${o.progress?.map((p) => `${p.label}:${p.state}`).join(" › ")} · ${o.paymentMethodLabel} ₹${o.amountPaidPaise / 100}`,
    };
  });
  await s.run("09-11", "Wallets are offered like in the app", "Payment Method: UPI / Card / Wallets / Cash on Delivery", async () => {
    await fill(2);
    const methods = (await me.call("POST", "/checkout/summary", {})).data.paymentMethods;
    const wallet = methods.find((m) => m.method === "wallet");
    return { ok: wallet?.enabled && wallet.label === "Wallets", detail: methods.map((m) => m.label).join(" | ") };
  });
  await s.run("09-12", "Save the card used, make it default, delete it", "“Save this payment method for faster checkout”, Payment Methods screen", async () => {
    const paymentId = (await me.call("GET", `/orders/${upi.data.order.orderId}`)).data && (await admin.call("GET", `/admin/payments?q=${upi.data.payment.gatewayOrderId}`)).data?.items?.[0]?.paymentId;
    const saved = await me.call("POST", "/payment-methods", { paymentId, makeDefault: true, type: "card", network: "Visa", last4: "4242" });
    const list = (await me.call("GET", "/payment-methods")).data || [];
    const stats = (await me.call("GET", "/users/me")).data.stats;
    const del = await me.call("DELETE", `/payment-methods/${saved.data?.methodId || saved.data?.paymentMethodId || saved.data?.id}`);
    const none = await me.call("POST", "/payment-methods", { paymentId: "000000000000000000000000" });
    return { ok: saved.status === 201 && list.some((m) => m.isDefault) && stats.paymentMethods >= 1 && del.status === 200 && none.status === 404, detail: `saved ${saved.status} ${JSON.stringify(list[0] || {}).slice(0, 120)} · profile count ${stats.paymentMethods} · delete ${del.status}` };
  });
  return s;
}
