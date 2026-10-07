import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCoupon } from "../src/modules/coupon/coupon.rules.js";
import { hoursOn, isOpenAt, orderingState } from "../src/modules/kitchen/kitchen.hours.js";
import { allowedFor, customerCanCancel } from "../src/modules/order/order.states.js";
import { computeBill } from "../src/modules/pricing/pricing.engine.js";
import { applyLimits, validateField } from "../src/modules/settings/settings.resolver.js";
import { istDateTime } from "../src/common/time.js";

const pricing = { deliveryFeeMode: "flat", deliveryFeePaise: 4000, freeDeliveryAbovePaise: 29900, packagingMode: "per_order", packagingPaise: 2000, tipEnabled: true };
const tax = { foodGstPercent: 5, deliveryGstPercent: 18, packagingGstPercent: 5, platformFeeGstPercent: 18 };

test("bill: free delivery strictly above threshold, GST per charge type", () => {
  const bill = computeBill({ lines: [{ lineId: "a", qty: 1, unitPricePaise: 29900 }], pricing, tax });
  assert.equal(bill.deliveryFeePaise, 4000); // equal to threshold is not above it
  assert.equal(bill.taxes.total, 1496 + 720 + 100);
  assert.equal(bill.grandTotalPaise, 29900 + 4000 + 2000 + 1496 + 720 + 100);
  const free = computeBill({ lines: [{ lineId: "a", qty: 1, unitPricePaise: 30000 }], pricing, tax });
  assert.equal(free.deliveryFeePaise, 0);
  assert.equal(free.deliveryFeeWaived, true);
});

test("bill: distance slabs, discount before tax, points and tip", () => {
  const bill = computeBill({
    lines: [{ lineId: "a", qty: 2, unitPricePaise: 10000 }],
    pricing: { ...pricing, deliveryFeeMode: "distance_slabs", deliverySlabs: [{ uptoKm: 2, feePaise: 2000 }, { uptoKm: 5, feePaise: 3500 }], freeDeliveryAbovePaise: 0 },
    tax,
    distanceKm: 3.2,
    discountPaise: 5000,
    tipPaise: 1000,
    pointsPaise: 500,
  });
  assert.equal(bill.deliveryFeePaise, 3500);
  assert.equal(bill.taxes.lines[0].taxablePaise, 15000);
  assert.equal(bill.tipPaise, 1000);
  assert.equal(bill.pointsPaise, 500);
});

test("bill: tax-inclusive menu prices extract GST instead of adding it", () => {
  const bill = computeBill({ lines: [{ lineId: "a", qty: 1, unitPricePaise: 10500 }], pricing: { packagingMode: "none", deliveryFeePaise: 0 }, tax: { ...tax, pricesIncludeTax: true } });
  assert.equal(bill.taxes.lines[0].taxablePaise, 10000);
  assert.equal(bill.grandTotalPaise, 10500);
});

test("bill: pickup has no delivery fee; IGST when inter-state", () => {
  const pickup = computeBill({ lines: [{ lineId: "a", qty: 1, unitPricePaise: 10000 }], pricing, tax, deliveryMode: "pickup" });
  assert.equal(pickup.deliveryFeePaise, 0);
  const inter = computeBill({ lines: [{ lineId: "a", qty: 1, unitPricePaise: 10000 }], pricing, tax, interState: true });
  assert.equal(inter.taxes.cgst, 0);
  assert.ok(inter.taxes.igst > 0);
});

test("coupons: min order, first order, percent cap", () => {
  const coupon = { isActive: true, approvalStatus: "live", type: "percent", value: 50, maxDiscountPaise: 10000, minOrderPaise: 20000, perUserLimit: 1, usageLimit: 0, firstOrderOnly: true };
  assert.equal(evaluateCoupon(coupon, { itemTotalPaise: 15000 }).reason, "min_order");
  assert.equal(evaluateCoupon(coupon, { itemTotalPaise: 50000, userDeliveredOrders: 1 }).reason, "first_order");
  assert.equal(evaluateCoupon(coupon, { itemTotalPaise: 50000 }).discountPaise, 10000);
  assert.equal(evaluateCoupon({ ...coupon, validTo: new Date(Date.now() - 1000) }, { itemTotalPaise: 50000 }).reason, "expired");
});

test("kitchen hours: closures, weekly overrides and hours past midnight", () => {
  const kitchen = { status: "active", acceptingOrders: true, opensAt: "18:00", closesAt: "02:00", weeklyHours: [], closures: [{ date: "2026-10-10", reason: "Diwali" }] };
  assert.equal(hoursOn(kitchen, "2026-10-10").closed, true);
  assert.equal(isOpenAt(kitchen, istDateTime("2026-10-07", "01:00")), true); // late part of the previous day
  assert.equal(isOpenAt(kitchen, istDateTime("2026-10-07", "12:00")), false);
  assert.equal(orderingState({ ...kitchen, acceptingOrders: false }, istDateTime("2026-10-07", "19:00")).reason, "paused");
});

test("order states: pickup skips dispatch; customers cancel only before accept", () => {
  assert.equal(allowedFor({ status: "ready", deliveryMode: "pickup" }, "delivered", "kitchen"), true);
  assert.equal(allowedFor({ status: "ready", deliveryMode: "delivery" }, "delivered", "kitchen"), false);
  assert.equal(allowedFor({ status: "accepted", deliveryMode: "delivery" }, "cancelled", "kitchen"), false);
  assert.equal(customerCanCancel({ status: "placed" }, { customerCancelPolicy: "before_accept" }), true);
  assert.equal(customerCanCancel({ status: "accepted" }, { customerCancelPolicy: "before_accept" }), false);
  assert.equal(customerCanCancel({ status: "placed", placedAt: new Date(Date.now() - 10 * 60_000) }, { customerCancelPolicy: "within_window", customerCancelWindowMinutes: 2 }), false);
});

test("settings: slabs validation and kitchen limits narrow ranges", () => {
  const field = { key: "s", label: "Slabs", type: "slabs" };
  assert.equal(validateField(field, [{ uptoKm: 2, feePaise: 100 }, { uptoKm: 1, feePaise: 200 }]).length, 1);
  const limited = applyLimits({ fields: [{ key: "fee", type: "money", min: 0, max: 100000, kitchenEditable: false }] }, { fee: { kitchenEditable: true, max: 6000 } });
  assert.equal(limited.fields[0].kitchenEditable, true);
  assert.equal(limited.fields[0].max, 6000);
});
