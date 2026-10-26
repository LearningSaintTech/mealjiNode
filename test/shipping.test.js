import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { orderPayload, toUpdate, verifySignature } from "../src/modules/delivery/shipping.provider.js";
import { riderCard, trackingFields } from "../src/modules/delivery/rider.view.js";

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
  assert.deepEqual(assigned.rider, { name: "Ravi K.", phone: null, phoneMasked: "+9198xxxxxx12", vehicleNumber: null, vehicleType: null, externalId: null, photoUrl: null, rating: null, deliveriesCount: null });
  assert.equal(assigned.clearRider, false);
  assert.equal(toUpdate(event("out_for_delivery")).status, "picked_up");
  assert.equal(toUpdate(event("delivered")).status, "delivered");
  assert.equal(toUpdate(event("created")).status, "booked"); // handed back: waiting for a new driver
  assert.equal(toUpdate(event("created")).clearRider, true);
  assert.equal(toUpdate(event("failed", { sub_status: "returning" })).subStatus, "returning");
  assert.deepEqual(toUpdate({ type: "driver.erased", data: { driver_id: "d-9" } }), { riderErased: "d-9" });
  const failed = toUpdate(event("failed", { reason: "customer_absent", location: { lat: 28.6, lng: 77.2 } }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.note, "customer_absent");
  assert.deepEqual(failed.location, { lat: 28.6, lng: 77.2 });
  assert.equal(toUpdate(event("cancelled")).status, "failed"); // cancelled on their side → re-booked here
  assert.equal(failed.pickedUp, true); // a failed delivery is never re-booked from the kitchen
  assert.equal(toUpdate(event("assigned")).pickedUp, false);
  assert.equal(toUpdate({ type: "order.created", data: { id: "ord-1" } }), null);
});

test("shipping order payload: kitchen pickup, recipient drop, COD and a future deadline only", () => {
  const job = { pickup: { latitude: 28.63, longitude: 77.21, address: "Kitchen St, Delhi" }, drop: { latitude: 28.6, longitude: 77.22, address: "12 MG Road" } };
  const kitchen = { name: "Tandoor House", phoneNumber: "+919800000001" };
  const context = { reference: "MJ-1001", recipient: { name: "Anita's mom", phone: "+919800000003" }, codPaise: 45050, deliverBy: new Date(Date.now() + 30 * 60_000), kitchen };
  const body = orderPayload(job, context);
  assert.equal(body.external_ref, "MJ-1001");
  assert.deepEqual(body.pickup, { name: "Tandoor House", phone: "+919800000001", address: "Kitchen St, Delhi", lat: 28.63, lng: 77.21 });
  assert.deepEqual(body.drop, { name: "Anita's mom", phone: "+919800000003", address: "12 MG Road", lat: 28.6, lng: 77.22 });
  assert.equal(body.cod_amount, 450.5);
  assert.ok(body.deliver_by);
  // A prepaid meal drop whose window already ended: no COD, no deadline (the platform refuses past ones).
  const meal = orderPayload(job, { ...context, reference: "meal 2026-10-24 lunch a1b2c3", codPaise: undefined, deliverBy: new Date(Date.now() - 60_000) });
  assert.equal(meal.cod_amount, 0);
  assert.equal(meal.deliver_by, undefined);
});

test("shipping webhook: rider card carries photo, rating, deliveries and the partner's rider id", () => {
  const update = toUpdate({ type: "order.status_changed", data: { order_id: "o", status: "assigned", version: 2, driver: { id: "d-1", name: "Ravi", phone_masked: "+9198xxxxxx12", vehicle_type: "bike", photo_url: "https://cdn.example/r.jpg", rating: 4.8, deliveries_count: 120 } } });
  assert.deepEqual(update.rider, { name: "Ravi", phone: null, phoneMasked: "+9198xxxxxx12", vehicleNumber: null, vehicleType: "bike", externalId: "d-1", photoUrl: "https://cdn.example/r.jpg", rating: 4.8, deliveriesCount: 120 });
});

test("rider card: partner riders are called through the app, kitchen riders directly", () => {
  const partner = riderCard({ name: "Ravi", phoneMasked: "+9198xxxxxx12", externalId: "d-1", rating: 4.8, deliveriesCount: 1240, vehicleType: "bike" }, { onTheWay: true });
  assert.equal(partner.canCall, false);
  assert.equal(partner.callNumber, null);
  assert.equal(partner.phoneMasked, "+9198xxxxxx12");
  assert.equal(partner.ratingLabel, "4.8 (1,240 deliveries)");
  const kitchenRider = riderCard({ name: "Sunil", phone: "9876543210" }, { onTheWay: true });
  assert.equal(kitchenRider.callNumber, "+919876543210");
  assert.equal(riderCard({ name: null }), null);
});

test("tracking fields: live ETA while open, problem notice after a failed delivery", () => {
  const eta = new Date(Date.now() + 12 * 60_000);
  const open = trackingFields({ status: "picked_up", eta, lastLocation: { lat: 1, lng: 2 }, deliveryOtp: "1234" }, { fallbackEta: new Date(Date.now() + 60 * 60_000), canCallRider: true });
  assert.equal(open.etaMinutes, 12);
  assert.equal(open.deliveryOtp, "1234");
  assert.deepEqual(open.location, { lat: 1, lng: 2 });
  const failed = trackingFields({ status: "failed", pickedUpAt: new Date(), lastLocation: { lat: 1, lng: 2 }, deliveryOtp: "1234", providerSubStatus: "returning" });
  assert.equal(failed.location, null);
  assert.equal(failed.deliveryOtp, null);
  assert.ok(failed.deliveryProblem);
  assert.equal(failed.deliverySubStatus, "returning");
});

test("tracking fields: rider position only once picked up; notice when no rider could be booked", () => {
  const assigned = trackingFields({ status: "assigned", lastLocation: { lat: 1, lng: 2 }, deliveryOtp: "1234" });
  assert.equal(assigned.location, null);
  assert.equal(assigned.deliveryOtp, "1234");
  const gaveUp = trackingFields({ status: "failed", pickedUpAt: null, gaveUpAt: new Date() });
  assert.equal(gaveUp.deliveryProblem, "We're having trouble finding a rider. Our team will contact you shortly.");
  // Before pickup and still re-booking: no notice yet.
  assert.equal(trackingFields({ status: "failed", pickedUpAt: null, gaveUpAt: null }).deliveryProblem, null);
  assert.equal(trackingFields({ status: "failed", pickedUpAt: new Date() }).deliveryProblem, "We couldn't deliver this. Our team will contact you shortly.");
});

test("rider leaves the delivery on hand-back or a failed booking before pickup, never after pickup", async () => {
  const { riderLeaves } = await import("../src/modules/delivery/delivery.service.js");
  assert.equal(riderLeaves({ clearRider: true }), true); // handed back
  assert.equal(riderLeaves({ status: "failed" }), true); // partner cancelled before pickup: re-booked
  assert.equal(riderLeaves({ status: "failed", pickedUp: true }), false); // delivery failed with the food
  assert.equal(riderLeaves({ status: "failed", pickedUpAt: new Date() }), false); // closed after pickup
  assert.equal(riderLeaves({ status: "assigned" }), false);
  assert.equal(riderLeaves({}), false);
});
