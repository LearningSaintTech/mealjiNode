import { distanceKm } from "../../common/geo.js";
import { entityForKitchen } from "../billing/billing.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { computeBill, estimateEtaMinutes } from "./pricing.engine.js";

const normalizeState = (value) => String(value || "").trim().toLowerCase();

/**
 * Prices priced lines for a kitchen with every setting resolved for it:
 * pricing, tax, loyalty (points), and the place-of-supply rule. Used by the
 * cart, checkout summary, order placement and subscriptions.
 */
export async function priceLines({ kitchen, lines, address = null, deliveryMode = "delivery", discountPaise = 0, freeDelivery = false, tipPaise = 0, usePoints = false, user = null, quotePaise = null, at = new Date() }) {
  const kitchenId = String(kitchen._id);
  const [pricing, tax, loyalty, policy, delivery, entity] = await Promise.all([
    resolveSetting("pricing", { kitchenId, city: kitchen.city }),
    resolveSetting("tax", { kitchenId, city: kitchen.city }),
    resolveSetting("loyalty"),
    resolveSetting("order_policy", { kitchenId, city: kitchen.city }),
    resolveSetting("delivery", { kitchenId, city: kitchen.city }),
    entityForKitchen(kitchenId),
  ]);
  const km = address && kitchen.latitude != null
    ? Math.round(distanceKm(kitchen.latitude, kitchen.longitude, address.latitude, address.longitude) * 100) / 100
    : 0;
  const supplierState = normalizeState(entity?.state || kitchen.state);
  const customerState = normalizeState(address?.state);
  const interState = Boolean(supplierState && customerState && supplierState !== customerState);
  const isPlusMember = user?.subscription?.status === "active";

  // Points are worth pointValuePaise each, capped at maxRedeemPercent of the bill.
  const draft = computeBill({ lines, pricing: pricing.values, tax: tax.values, deliveryMode, distanceKm: km, quotePaise, discountPaise, tipPaise, isPlusMember, interState, at });
  let bill = draft;
  if (freeDelivery && draft.deliveryFeePaise > 0) {
    bill = computeBill({ lines, pricing: { ...pricing.values, deliveryFeeMode: "flat", deliveryFeePaise: 0 }, tax: tax.values, deliveryMode, distanceKm: km, discountPaise, tipPaise, isPlusMember, interState, at });
    bill = { ...bill, deliveryFeeFullPaise: draft.deliveryFeePaise, deliveryFeeWaived: true, savingsPaise: bill.savingsPaise + draft.deliveryFeePaise, amountToFreeDeliveryPaise: 0 };
  }
  let points = { available: 0, usable: 0, usedPoints: 0, valuePaise: loyalty.values.pointValuePaise };
  if (user && loyalty.values.enabled) {
    const balance = Math.max(0, user.pointsBalance || 0);
    const value = loyalty.values.pointValuePaise || 0;
    const capPaise = Math.floor((bill.grandTotalPaise * (loyalty.values.maxRedeemPercent || 0)) / 100);
    const usablePoints = value > 0 ? Math.min(balance, Math.floor(capPaise / value)) : 0;
    points = { available: balance, usable: usablePoints, usedPoints: 0, valuePaise: value };
    if (usePoints && usablePoints > 0) {
      bill = { ...bill, pointsPaise: usablePoints * value, grandTotalPaise: bill.grandTotalPaise - usablePoints * value };
      points.usedPoints = usablePoints;
    }
  }
  const etaMinutes = estimateEtaMinutes({
    prepMinutes: policy.values.avgPrepMinutes,
    distanceKm: km,
    minutesPerKm: delivery.values.minutesPerKm,
    bufferMinutes: delivery.values.etaBufferMinutes,
    pickup: deliveryMode === "pickup",
  });
  return {
    bill,
    points,
    distanceKm: km,
    etaMinutes: deliveryMode === "pickup" ? pricing.values.pickupReadyMinutes : etaMinutes,
    tip: { enabled: Boolean(pricing.values.tipEnabled), presetsPaise: pricing.values.tipPresetsPaise || [] },
    policy: policy.values,
    pricingValues: pricing.values,
    taxValues: tax.values,
  };
}
