import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { orderPayload, toUpdate, verifySignature } from "../src/modules/delivery/shipping.provider.js";

const secret = "whsec_test";
function sign(body, ts, key = secret) {
  return `sha256=${crypto.createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}`;
}

test("shipping webhook: signature over timestamp.body, with rotation and replay guard", () => {
  const body = Buffer.from('{"type":"order.status_changed"}');
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  assert.equal(verifySignature(body, { "x-timestamp": ts, "x-signature": sign(body, ts) }, secret, now), true);
  // During a secret rotation the old secret signs x-signature, the new one x-signature-previous (or the reverse).
  assert.equal(verifySignature(body, { "x-timestamp": ts, "x-signature": sign(body, ts, "old"), "x-signature-previous": sign(body, ts) }, secret, now), true);
  assert.equal(verifySignature(body, { "x-timestamp": ts, "x-signature": sign(body, ts, "wrong") }, secret, now), false);
  assert.equal(verifySignature(Buffer.from("{}"), { "x-timestamp": ts, "x-signature": sign(body, ts) }, secret, now), false);
  // Older than five minutes, or no timestamp: rejected even with a valid signature.
  const old = String(now / 1000 - 301);
  assert.equal(verifySignature(body, { "x-timestamp": old, "x-signature": sign(body, old) }, secret, now), false);
  assert.equal(verifySignature(body, { "x-signature": sign(body, ts) }, secret, now), false);
});

test("shipping webhook: platform statuses map to delivery job updates", () => {
  const event = (status, extra = {}) => ({ type: "order.status_changed", data: { order_id: "ord-1", status, sub_status: status, version: 3, ...extra } });
  const assigned = toUpdate(event("assigned", { driver: { name: "Ravi K.", phone_masked: "+9198xxxxxx12" } }));
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.providerJobId, "ord-1");
  assert.equal(assigned.version, 3);
  assert.deepEqual(assigned.rider, { name: "Ravi K.", phone: "+9198xxxxxx12", vehicleNumber: null });
  assert.equal(toUpdate(event("out_for_delivery")).status, "picked_up");
  assert.equal(toUpdate(event("delivered")).status, "delivered");
  assert.equal(toUpdate(event("created")).status, "booked"); // handed back: waiting for a new driver
  const failed = toUpdate(event("failed", { reason: "customer_absent", location: { lat: 28.6, lng: 77.2 } }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.note, "customer_absent");
  assert.deepEqual(failed.location, { lat: 28.6, lng: 77.2 });
  assert.equal(toUpdate(event("cancelled")).status, "failed"); // cancelled on their side → re-booked here
  assert.equal(failed.pickedUp, true); // a failed delivery is never re-booked from the kitchen
  assert.equal(toUpdate(event("assigned")).pickedUp, false);
  assert.equal(toUpdate({ type: "order.created", data: { id: "ord-1" } }), null);
});

test("shipping order payload: kitchen pickup, customer drop, COD only while unpaid", () => {
  const job = { pickup: { latitude: 28.63, longitude: 77.21, address: "Kitchen St, Delhi" }, drop: { latitude: 28.6, longitude: 77.22, address: "12 MG Road" } };
  const kitchen = { name: "Tandoor House", phoneNumber: "+919800000001" };
  const order = {
    orderNumber: "MJ-1001",
    paymentMethod: "cod",
    paymentStatus: "cod_pending",
    bill: { grandTotalPaise: 45050 },
    customer: { name: "Anita", phone: "+919800000002" },
    address: { recipientName: "Anita's mom", phone: "+919800000003" },
    estimatedDeliveryAt: new Date(Date.now() + 30 * 60_000),
  };
  const body = orderPayload(job, { order, kitchen });
  assert.equal(body.external_ref, "MJ-1001");
  assert.deepEqual(body.pickup, { name: "Tandoor House", phone: "+919800000001", address: "Kitchen St, Delhi", lat: 28.63, lng: 77.21 });
  assert.deepEqual(body.drop, { name: "Anita's mom", phone: "+919800000003", address: "12 MG Road", lat: 28.6, lng: 77.22 });
  assert.equal(body.cod_amount, 450.5);
  assert.ok(body.deliver_by);
  const paid = orderPayload(job, { order: { ...order, paymentMethod: "upi", paymentStatus: "paid", estimatedDeliveryAt: new Date(Date.now() - 60_000) }, kitchen });
  assert.equal(paid.cod_amount, 0);
  assert.equal(paid.deliver_by, undefined); // a past ETA is not sent (the platform refuses it)
});
