import { percentOf } from "../../common/money.js";

/**
 * Whether a coupon applies to a cart and how much it takes off (pure).
 * context = { itemTotalPaise, deliveryFeePaise, kitchenId, city, paymentMethod,
 *             userDeliveredOrders, userRedemptions, segmentIds, now, userId,
 *             lines (priced cart lines: kind, dishId, qty, unitPricePaise; for free-dish rewards) }
 */
export function evaluateCoupon(coupon, context) {
  const now = context.now || new Date();
  const fail = (reason, message) => ({ valid: false, reason, message, discountPaise: 0, freeDelivery: false });
  if (!coupon || !coupon.isActive || coupon.approvalStatus !== "live") return fail("invalid", "This code is not valid");
  // A reward coupon only works for the customer who redeemed it.
  if (coupon.owner && String(coupon.owner) !== String(context.userId || "")) return fail("invalid", "This code is not valid");
  if (coupon.validFrom && new Date(coupon.validFrom) > now) return fail("not_started", "This offer has not started yet");
  if (coupon.validTo && new Date(coupon.validTo) < now) return fail("expired", "This offer has expired");
  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) return fail("exhausted", "This offer has been fully used");
  if (coupon.perUserLimit > 0 && (context.userRedemptions || 0) >= coupon.perUserLimit) return fail("used", "You have already used this offer");
  if (coupon.firstOrderOnly && (context.userDeliveredOrders || 0) > 0) return fail("first_order", "This offer is for your first order");
  if (coupon.kitchens?.length && !coupon.kitchens.map(String).includes(String(context.kitchenId))) return fail("kitchen", "Not valid at this kitchen");
  if (coupon.fundedBy === "kitchen" && coupon.kitchen && String(coupon.kitchen) !== String(context.kitchenId)) return fail("kitchen", "Not valid at this kitchen");
  if (coupon.cities?.length && !coupon.cities.includes(String(context.city || "").toLowerCase())) return fail("city", "Not valid in your city");
  if (coupon.segment && !(context.segmentIds || []).includes(String(coupon.segment))) return fail("segment", "This offer is not available to you");
  if (coupon.paymentMethods?.length && context.paymentMethod && !coupon.paymentMethods.includes(context.paymentMethod)) {
    return fail("payment_method", `Pay with ${coupon.paymentMethods.join(" / ")} to use this offer`);
  }
  if (coupon.minOrderPaise > 0 && context.itemTotalPaise < coupon.minOrderPaise) {
    return { ...fail("min_order", "Add more to use this offer"), shortByPaise: coupon.minOrderPaise - context.itemTotalPaise };
  }

  if (coupon.dish) {
    // The same dish at any kitchen (kitchens share dish names); add-ons are not free.
    const units = (context.lines || [])
      .filter((line) => line.kind === "dish" && (String(line.dishId) === String(coupon.dish) || (coupon.dishName && line.name === coupon.dishName)))
      .flatMap((line) => Array.from({ length: line.qty }, () => line.basePricePaise ?? line.unitPricePaise))
      .sort((a, b) => a - b)
      .slice(0, coupon.dishQty || 1);
    if (!units.length) return { ...fail("dish_missing", `Add ${coupon.dishName || "the dish"} to your cart to use this reward`), dishId: String(coupon.dish) };
    let free = units.reduce((sum, price) => sum + price, 0);
    if (coupon.maxDiscountPaise > 0) free = Math.min(free, coupon.maxDiscountPaise);
    free = Math.max(0, Math.min(free, context.itemTotalPaise));
    return { valid: true, reason: null, message: `${coupon.title} applied`, discountPaise: free, freeDelivery: false };
  }
  if (coupon.type === "free_delivery") {
    return { valid: true, reason: null, message: "Free delivery applied", discountPaise: 0, freeDelivery: true };
  }
  let discount = coupon.type === "flat" ? coupon.value : percentOf(context.itemTotalPaise, coupon.value);
  if (coupon.maxDiscountPaise > 0) discount = Math.min(discount, coupon.maxDiscountPaise);
  discount = Math.max(0, Math.min(discount, context.itemTotalPaise));
  return { valid: true, reason: null, message: `You save ₹${(discount / 100).toFixed(0)}`, discountPaise: discount, freeDelivery: false };
}

export function couponLabel(coupon) {
  if (coupon.dish) return coupon.title;
  if (coupon.type === "free_delivery") return "Free delivery";
  if (coupon.type === "flat") return `₹${Math.round(coupon.value / 100)} off`;
  return `${coupon.value}% off${coupon.maxDiscountPaise ? ` up to ₹${Math.round(coupon.maxDiscountPaise / 100)}` : ""}`;
}
