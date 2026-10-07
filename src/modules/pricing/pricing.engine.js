import { percentOf, splitGst } from "../../common/money.js";
import { isWithinIstWindow } from "../../common/time.js";

/**
 * The one bill formula (pure, no database). Every amount is integer paise.
 * The cart, the checkout summary and order placement all call this with the
 * pricing and tax settings resolved for the kitchen, so the app never computes
 * money on its own.
 *
 * input = {
 *   lines: [{ lineId, qty, unitPricePaise, originalUnitPricePaise?, packagingPaise? }],
 *   pricing, tax,                      // resolved setting values
 *   deliveryMode: "delivery" | "pickup",
 *   distanceKm, quotePaise?,           // quote = delivery partner's price (provider_quote mode)
 *   discountPaise?,                    // coupon discount, already capped by the coupon rules
 *   pointsPaise?,                      // points redeemed as money
 *   tipPaise?, isPlusMember?, interState?, at?
 * }
 */
export function computeBill(input) {
  const pricing = input.pricing || {};
  const tax = input.tax || {};
  const lines = (input.lines || []).filter((line) => line.qty > 0);
  const at = input.at || new Date();
  const pickup = input.deliveryMode === "pickup";

  const lineTotals = lines.map((line) => ({
    lineId: line.lineId,
    qty: line.qty,
    unitPricePaise: line.unitPricePaise,
    totalPaise: line.unitPricePaise * line.qty,
    mrpTotalPaise: Math.max(line.originalUnitPricePaise || 0, line.unitPricePaise) * line.qty,
  }));
  const itemTotalPaise = lineTotals.reduce((sum, line) => sum + line.totalPaise, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.qty, 0);
  const mrpSavingsPaise = lineTotals.reduce((sum, line) => sum + (line.mrpTotalPaise - line.totalPaise), 0);

  const discountPaise = Math.min(Math.max(0, input.discountPaise || 0), itemTotalPaise);

  // Delivery fee.
  let deliveryFeeFullPaise = 0;
  if (!pickup && itemCount > 0) {
    if (pricing.deliveryFeeMode === "distance_slabs" && Array.isArray(pricing.deliverySlabs) && pricing.deliverySlabs.length) {
      const km = Number(input.distanceKm) || 0;
      const slab = pricing.deliverySlabs.find((item) => km <= item.uptoKm) || pricing.deliverySlabs[pricing.deliverySlabs.length - 1];
      deliveryFeeFullPaise = slab.feePaise;
    } else if (pricing.deliveryFeeMode === "provider_quote" && Number.isInteger(input.quotePaise)) {
      deliveryFeeFullPaise = Math.max(0, input.quotePaise + percentOf(input.quotePaise, pricing.quoteMarkupPercent || 0));
    } else {
      deliveryFeeFullPaise = pricing.deliveryFeePaise || 0;
    }
  }
  const threshold = pricing.freeDeliveryAbovePaise || 0;
  const freeByThreshold = threshold > 0 && itemTotalPaise > threshold;
  const freeByPlus = Boolean(input.isPlusMember && pricing.plusFreeDelivery);
  const deliveryWaived = !pickup && deliveryFeeFullPaise > 0 && (freeByThreshold || freeByPlus);
  const deliveryFeePaise = deliveryWaived ? 0 : deliveryFeeFullPaise;

  // Packaging.
  let packagingPaise = 0;
  if (itemCount > 0) {
    if (pricing.packagingMode === "per_order") packagingPaise = pricing.packagingPaise || 0;
    else if (pricing.packagingMode === "per_item") packagingPaise = (pricing.packagingPaise || 0) * itemCount;
    else if (pricing.packagingMode === "per_dish") packagingPaise = lines.reduce((sum, line) => sum + (line.packagingPaise || 0) * line.qty, 0);
  }

  const smallOrderFeePaise = itemCount > 0 && pricing.smallOrderBelowPaise > 0 && itemTotalPaise < pricing.smallOrderBelowPaise
    ? pricing.smallOrderFeePaise || 0
    : 0;
  const platformFeePaise = itemCount > 0 ? pricing.platformFeePaise || 0 : 0;
  const surgeFeePaise = itemCount > 0 && !pickup && pricing.surgeEnabled && pricing.surgeStart && pricing.surgeEnd
    && isWithinIstWindow(at, pricing.surgeStart, pricing.surgeEnd)
    ? pricing.surgeFeePaise || 0
    : 0;
  const tipPaise = pricing.tipEnabled ? Math.max(0, input.tipPaise || 0) : 0;

  // Taxes. Food may be priced tax-inclusive; charges are always exclusive.
  const interState = tax.supplyRule === "always_intra" ? false : Boolean(input.interState);
  const foodRate = Number(tax.foodGstPercent ?? 5);
  const foodGross = itemTotalPaise - discountPaise;
  let foodTaxable;
  let foodTax;
  if (tax.pricesIncludeTax) {
    foodTaxable = Math.round((foodGross * 100) / (100 + foodRate));
    const total = foodGross - foodTaxable;
    const half = Math.floor(total / 2);
    foodTax = interState
      ? { cgst: 0, sgst: 0, igst: total, total }
      : { cgst: half, sgst: total - half, igst: 0, total };
  } else {
    foodTaxable = foodGross;
    foodTax = splitGst(foodTaxable, foodRate, { interState });
  }
  const taxLines = [{ type: "food", sac: tax.foodSac || null, taxablePaise: foodTaxable, ratePercent: foodRate, ...foodTax }];
  const charge = (type, amount, rate, sac = null) => {
    if (!amount) return;
    taxLines.push({ type, sac, taxablePaise: amount, ratePercent: rate, ...splitGst(amount, rate, { interState }) });
  };
  charge("delivery", deliveryFeePaise + surgeFeePaise, Number(tax.deliveryGstPercent ?? 18), tax.deliverySac || null);
  charge("packaging", packagingPaise, Number(tax.packagingGstPercent ?? 5));
  charge("fees", platformFeePaise + smallOrderFeePaise, Number(tax.platformFeeGstPercent ?? 18));

  const taxes = taxLines.reduce((acc, line) => ({
    cgst: acc.cgst + line.cgst,
    sgst: acc.sgst + line.sgst,
    igst: acc.igst + line.igst,
    total: acc.total + line.total,
  }), { cgst: 0, sgst: 0, igst: 0, total: 0 });

  const foodPayable = tax.pricesIncludeTax ? foodGross : foodGross + foodTax.total;
  const chargesTax = taxes.total - foodTax.total;
  const beforePoints = foodPayable + deliveryFeePaise + packagingPaise + smallOrderFeePaise + platformFeePaise + surgeFeePaise + chargesTax + tipPaise;
  const pointsPaise = Math.min(Math.max(0, input.pointsPaise || 0), beforePoints);
  const grandTotalPaise = beforePoints - pointsPaise;

  return {
    itemCount,
    itemTotalPaise,
    discountPaise,
    deliveryFeePaise,
    deliveryFeeFullPaise,
    deliveryFeeWaived: deliveryWaived,
    packagingPaise,
    smallOrderFeePaise,
    platformFeePaise,
    surgeFeePaise,
    tipPaise,
    pointsPaise,
    taxes: { ...taxes, interState, pricesIncludeTax: Boolean(tax.pricesIncludeTax), lines: taxLines },
    savingsPaise: discountPaise + mrpSavingsPaise + (deliveryWaived ? deliveryFeeFullPaise : 0),
    grandTotalPaise,
    freeDeliveryAbovePaise: threshold || null,
    amountToFreeDeliveryPaise: !pickup && threshold > 0 && !freeByThreshold ? threshold - itemTotalPaise + 1 : 0,
    lines: lineTotals,
  };
}

/** Distance-based delivery ETA in minutes. */
export function estimateEtaMinutes({ prepMinutes = 20, distanceKm = 0, minutesPerKm = 4, bufferMinutes = 5, pickup = false }) {
  if (pickup) return prepMinutes;
  return Math.round(prepMinutes + Math.max(0, distanceKm) * minutesPerKm + bufferMinutes);
}
