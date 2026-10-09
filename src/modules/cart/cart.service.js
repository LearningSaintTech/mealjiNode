import crypto from "node:crypto";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { Address, addressSnapshot } from "../address/address.model.js";
import { isOrderable, kitchenMenu, markFavorites, popularDishes, unavailableMessage, unavailableReason } from "../catalog/catalog.service.js";
import { kitchenRepository } from "../kitchen/kitchen.repository.js";
import { KitchenCombo, KitchenDish } from "../catalog/catalog.model.js";
import { checkCode } from "../coupon/coupon.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { hoursOn, isOpenAt, orderingState } from "../kitchen/kitchen.hours.js";
import { addIstDays, istDateKey, istDateTime, parseHhmm } from "../../common/time.js";
import { resolveSetting } from "../settings/settings.service.js";
import { priceLines } from "../pricing/pricing.service.js";
import { kitchenCovers } from "../serviceability/serviceability.service.js";
import { User } from "../user/user.model.js";
import { Cart } from "./cart.model.js";

const PAYMENT_METHODS = ["upi", "card", "netbanking", "wallet", "cod"];
// How the checkout lists each way to pay (the app's own wording).
const PAYMENT_LABELS = {
  upi: { label: "UPI (Recommended)", description: "Pay with any UPI app" },
  card: { label: "Credit / Debit Card", description: "Visa, Mastercard, RuPay" },
  netbanking: { label: "Net Banking", description: "All major banks" },
  wallet: { label: "Wallets", description: "Paytm, PhonePe, GPay" },
  cod: { label: "Cash on Delivery", description: "Pay when you receive" },
};
const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** “Large • Extra Butter Jeera Rice • + Complete Meal”, or “Regular” with no choices. */
function optionsText(line) {
  const parts = [line.portion?.label, ...(line.options || []).map((option) => option.name), line.mealUpgrade ? `+ ${line.mealUpgrade.label}` : null].filter(Boolean);
  return parts.length ? parts.join(" • ") : "Regular";
}

/**
 * The bill as rows the app prints top to bottom (no maths in the app):
 * Item total, Delivery fee (FREE with the struck-out fee), Packaging, fees,
 * Taxes (GST), Coupon discount, Tip, Points, then Total amount.
 */
function billLines(bill, coupon) {
  const rows = [{ key: "items", label: `Item total (${bill.itemCount} item${bill.itemCount === 1 ? "" : "s"})`, amountPaise: bill.itemTotalPaise }];
  if (bill.deliveryFeeWaived) rows.push({ key: "delivery", label: "Delivery fee", amountPaise: 0, text: "FREE", strikePaise: bill.deliveryFeeFullPaise });
  else if (bill.deliveryFeePaise) rows.push({ key: "delivery", label: "Delivery fee", amountPaise: bill.deliveryFeePaise });
  if (bill.packagingPaise) rows.push({ key: "packaging", label: "Packaging charge", amountPaise: bill.packagingPaise });
  if (bill.platformFeePaise) rows.push({ key: "platform", label: "Platform fee", amountPaise: bill.platformFeePaise });
  if (bill.smallOrderFeePaise) rows.push({ key: "small_order", label: "Small order fee", amountPaise: bill.smallOrderFeePaise });
  if (bill.surgeFeePaise) rows.push({ key: "surge", label: "Busy-time fee", amountPaise: bill.surgeFeePaise });
  if (!bill.taxes.pricesIncludeTax && bill.taxes.total) rows.push({ key: "taxes", label: "Taxes (GST)", amountPaise: bill.taxes.total });
  else if (bill.taxes.total) rows.push({ key: "taxes", label: "Taxes (GST)", amountPaise: bill.taxes.total - (bill.taxes.lines?.[0]?.total || 0), note: "Food prices include GST" });
  if (bill.discountPaise) rows.push({ key: "discount", label: coupon?.code ? `Coupon discount (${coupon.code})` : "Discount", amountPaise: -bill.discountPaise });
  if (bill.tipPaise) rows.push({ key: "tip", label: "Tip for your rider", amountPaise: bill.tipPaise });
  if (bill.pointsPaise) rows.push({ key: "points", label: "Meal Ji points used", amountPaise: -bill.pointsPaise });
  rows.push({ key: "total", label: "Total amount", amountPaise: bill.grandTotalPaise, isTotal: true });
  return rows;
}

// ---- delivery time: as soon as possible, or a half-hour slot today/tomorrow

/** Delivery options for a kitchen (shared by GET /delivery/slots and the cart). */
export async function deliverySlots(kitchen, now = new Date()) {
  const app = (await resolveSetting("app")).values;
  const options = [{ type: "asap", label: "As soon as possible", available: Boolean(kitchen && isOpenAt(kitchen, now) && kitchen.acceptingOrders) }];
  const scheduled = [];
  if (kitchen && app.featureScheduledDelivery) {
    for (const offset of [0, 1]) {
      const dateKey = addIstDays(istDateKey(now), offset);
      const hours = hoursOn(kitchen, dateKey);
      if (hours.closed) continue;
      const start = parseHhmm(hours.opensAt);
      const end = parseHhmm(hours.closesAt) > start ? parseHhmm(hours.closesAt) : 24 * 60;
      for (let minute = Math.ceil(start / 30) * 30 + 30; minute + 30 <= end; minute += 30) {
        const from = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const to = `${String(Math.floor((minute + 30) / 60)).padStart(2, "0")}:${String((minute + 30) % 60).padStart(2, "0")}`;
        const at = istDateTime(dateKey, from);
        if (at.getTime() < now.getTime() + 45 * 60 * 1000) continue;
        scheduled.push({ date: dateKey, from, to, startsAt: at, label: `${offset ? "Tomorrow" : "Today"} ${from}–${to}` });
      }
    }
  }
  return { options, scheduled, scheduledEnabled: Boolean(app.featureScheduledDelivery) };
}

const lineKey = (line) => [line.kind, String(line.dish || line.combo), line.portionId || "", line.mealUpgrade ? 1 : 0, [...(line.optionIds || [])].sort().join(",")].join("|");

async function getCart(userId) {
  return (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] });
}

const CONFLICT_RETRIES = 8;
const isConflict = (err) => err?.name === "VersionError" || err?.code === 11000;

/**
 * Read → change → save, retried on a fresh copy when another request saved
 * the cart in between (parallel taps on +, two devices). `change` may run more
 * than once, so it only edits the cart it is given.
 */
async function mutateCart(userId, change, { event = true, user = null } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const cart = await getCart(userId);
    await change(cart);
    try {
      return await saveAndBuild(cart, userId, event, user);
    } catch (err) {
      if (!isConflict(err) || attempt >= CONFLICT_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 20 * attempt));
    }
  }
}

/** Validates options against the dish's groups and returns the chosen options. */
function chosenOptions(dish, optionIds = []) {
  const chosen = [];
  const errors = [];
  const wanted = new Set(optionIds);
  for (const group of dish.customizationGroups || []) {
    const picked = (group.options || []).filter((option) => wanted.has(option.optionId));
    if (picked.length < (group.minSelect || 0)) errors.push(`${group.name}: choose at least ${group.minSelect}`);
    if (picked.length > (group.maxSelect || 1)) errors.push(`${group.name}: choose at most ${group.maxSelect}`);
    for (const option of picked) {
      if (option.isAvailable === false) errors.push(`${option.name} is not available`);
      chosen.push({ optionId: option.optionId, name: option.name, groupName: group.name, pricePaise: option.pricePaise || 0 });
      wanted.delete(option.optionId);
    }
  }
  if (wanted.size) errors.push("Some options are not on this dish");
  return { chosen, errors };
}

/** Prices one stored line against the live menu. */
export function priceLine(line, dishes, combos, at = new Date()) {
  if (line.kind === "combo") {
    const combo = combos.get(String(line.combo));
    if (!combo) return { lineId: line.lineId, kind: "combo", comboId: String(line.combo), qty: line.qty, isAvailable: false, issue: "removed", unitPricePaise: 0, totalPaise: 0, name: "Combo no longer available" };
    const dishOk = (combo.items || []).every((item) => isOrderable(dishes.get(String(item.dish)), at));
    const available = combo.isActive && combo.isAvailable && combo.approvalStatus === "live" && dishOk;
    return {
      lineId: line.lineId,
      kind: "combo",
      comboId: String(combo._id),
      name: combo.title,
      imageUrl: combo.imageUrl || null,
      isVeg: (combo.items || []).every((item) => dishes.get(String(item.dish))?.isVeg !== false),
      qty: line.qty,
      unitPricePaise: combo.pricePaise,
      originalUnitPricePaise: combo.originalPricePaise || combo.pricePaise,
      packagingPaise: 0,
      totalPaise: combo.pricePaise * line.qty,
      isAvailable: available,
      issue: available ? null : "unavailable",
      priceChanged: line.seenUnitPricePaise != null && line.seenUnitPricePaise !== combo.pricePaise,
      dishIds: (combo.items || []).map((item) => ({ dishId: String(item.dish), qty: item.qty * line.qty })),
    };
  }
  const dish = dishes.get(String(line.dish));
  if (!dish || !dish.isActive || dish.approvalStatus !== "live") {
    return { lineId: line.lineId, kind: "dish", dishId: String(line.dish), qty: line.qty, isAvailable: false, issue: "removed", unitPricePaise: 0, totalPaise: 0, name: dish?.name || "Dish no longer available" };
  }
  const portion = line.portionId ? (dish.portions || []).find((item) => item.portionId === line.portionId) : null;
  const base = portion ? portion.pricePaise : dish.pricePaise;
  const upgrade = line.mealUpgrade && dish.mealUpgrade?.label ? dish.mealUpgrade.pricePaise || 0 : 0;
  const { chosen, errors } = chosenOptions(dish, line.optionIds);
  const extras = upgrade + chosen.reduce((sum, option) => sum + option.pricePaise, 0);
  const unit = base + extras;
  // Struck-out price: the dish's MRP (when no portion is chosen) and the meal upgrade's own saving.
  const upgradeSaving = upgrade && dish.mealUpgrade.originalPricePaise > upgrade ? dish.mealUpgrade.originalPricePaise - upgrade : 0;
  const original = (!portion && dish.originalPricePaise > dish.pricePaise ? dish.originalPricePaise : base) + extras + upgradeSaving;
  const available = isOrderable(dish, at) && !errors.length && (!line.portionId || Boolean(portion));
  return {
    lineId: line.lineId,
    kind: "dish",
    dishId: String(dish._id),
    name: dish.name,
    imageUrl: dish.images?.[0] || null,
    isVeg: dish.isVeg !== false,
    qty: line.qty,
    portion: portion ? { portionId: portion.portionId, label: portion.label } : null,
    mealUpgrade: line.mealUpgrade && dish.mealUpgrade?.label ? { label: dish.mealUpgrade.label, pricePaise: upgrade } : null,
    options: chosen,
    specialInstructions: line.specialInstructions || null,
    unitPricePaise: unit,
    originalUnitPricePaise: original,
    packagingPaise: dish.packagingPaise || 0,
    totalPaise: unit * line.qty,
    isAvailable: available,
    issue: available ? null : errors.length ? "options_changed" : "unavailable",
    priceChanged: line.seenUnitPricePaise != null && line.seenUnitPricePaise !== unit,
    dishIds: [{ dishId: String(dish._id), qty: line.qty }],
  };
}

/**
 * Dishes and combos for pricing, from the kitchen's cached live menu (refreshed
 * within 10 s of an edit). Dishes no longer on the menu are simply missing,
 * which prices the line as “removed”. Stock is re-checked atomically at order time.
 */
async function menuMaps(kitchenId) {
  const menu = await kitchenMenu(String(kitchenId));
  return { dishes: new Map(menu.rawDishes.map((dish) => [String(dish._id), dish])), combos: new Map(menu.rawCombos.map((combo) => [String(combo._id), combo])) };
}

/**
 * The full priced cart / checkout summary. Everything money-related comes from
 * the server: lines re-priced from the live menu, the bill from the kitchen's
 * pricing and tax settings, the coupon re-validated, points capped, plus the
 * reasons checkout is blocked (if any).
 */
export async function buildCart(userId, overrides = {}, { user: loaded = null, cart: saved = null } = {}) {
  const cart = saved || await getCart(userId);
  // The signed-in user is already loaded by the auth check when the route passes it.
  const user = loaded || await User.findById(userId).lean();
  const deliveryMode = overrides.deliveryMode || cart.deliveryMode || "delivery";
  const tipPaise = overrides.tipPaise ?? cart.tipPaise ?? 0;
  const usePoints = overrides.usePoints ?? cart.usePoints ?? false;
  const paymentMethod = overrides.paymentMethod || null;
  const addressId = overrides.addressId || (cart.address ? String(cart.address) : null);
  const autoAddress = !overrides.addressId && !cart.address;
  const scheduledFor = overrides.scheduledFor !== undefined ? overrides.scheduledFor : cart.scheduledFor || null;

  const empty = {
    cartId: cart._id ? String(cart._id) : null,
    kitchen: null,
    items: [],
    itemCount: 0,
    coupon: null,
    bill: null,
    deliveryMode,
    tipPaise: 0,
    usePoints: false,
    chefNote: cart.chefNote || null,
    address: null,
    canCheckout: false,
    blockers: [{ code: "EMPTY", message: "Your cart is empty" }],
  };
  if (!cart.items.length || !cart.kitchen) return empty;

  const kitchen = await kitchenRepository.findActiveById(cart.kitchen);
  if (!kitchen) return empty;
  const { dishes, combos } = await menuMaps(cart.kitchen);
  const now = new Date();
  const lines = cart.items.map((line) => priceLine(line, dishes, combos, now));
  const orderable = lines.filter((line) => line.isAvailable);
  const itemTotalPaise = orderable.reduce((sum, line) => sum + line.totalPaise, 0);

  let address = null;
  if (deliveryMode === "delivery" && addressId) {
    address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: userId, deletedAt: null }).lean();
  }
  // Nothing chosen yet: use the default address (else the newest one this kitchen delivers to).
  if (deliveryMode === "delivery" && !address && autoAddress) {
    const saved = await Address.find({ user: userId, deletedAt: null }).sort({ isDefault: -1, updatedAt: -1 }).limit(20).lean();
    address = saved.find((item) => kitchenCovers(kitchen, item.latitude, item.longitude)) || saved[0] || null;
  }

  let coupon = null;
  let discountPaise = 0;
  let freeDelivery = false;
  if (cart.couponCode) {
    const { coupon: found, result } = await checkCode(cart.couponCode, { userId, kitchenId: kitchen._id, city: kitchen.city, itemTotalPaise, paymentMethod });
    coupon = { code: cart.couponCode, valid: result.valid, message: result.message, discountPaise: result.discountPaise, freeDelivery: Boolean(result.freeDelivery), title: found?.title || null, shortByPaise: result.shortByPaise || 0 };
    if (result.valid) {
      discountPaise = result.discountPaise;
      freeDelivery = Boolean(result.freeDelivery);
    }
  }

  const priced = await priceLines({
    kitchen,
    lines: orderable.map((line) => ({ lineId: line.lineId, qty: line.qty, unitPricePaise: line.unitPricePaise, originalUnitPricePaise: line.originalUnitPricePaise, packagingPaise: line.packagingPaise })),
    address,
    deliveryMode,
    discountPaise,
    freeDelivery,
    tipPaise,
    usePoints,
    user,
  });

  const blockers = [];
  const state = orderingState(kitchen, now);
  const slots = await deliverySlots(kitchen, now);
  const slot = scheduledFor ? slots.scheduled.find((item) => item.startsAt.getTime() === new Date(scheduledFor).getTime()) : null;
  if (scheduledFor && !slot) blockers.push({ code: "SLOT_UNAVAILABLE", message: "That delivery time is no longer available. Choose another time." });
  // A scheduled order can be placed while the kitchen is closed now.
  if (!state.canOrder && !slot) blockers.push({ code: "KITCHEN_CLOSED", message: state.message, opensAt: state.opensAt || null });
  const unavailable = lines.filter((line) => !line.isAvailable);
  if (unavailable.length) blockers.push({ code: "ITEMS_UNAVAILABLE", message: `${unavailable.length} item(s) are not available. Remove them to continue.`, lineIds: unavailable.map((line) => line.lineId) });
  if (!orderable.length) blockers.push({ code: "EMPTY", message: "Nothing in your cart can be ordered" });
  if (priced.policy.minOrderPaise > 0 && itemTotalPaise < priced.policy.minOrderPaise) {
    blockers.push({ code: "MIN_ORDER", message: `Minimum order is ₹${Math.round(priced.policy.minOrderPaise / 100)}`, shortByPaise: priced.policy.minOrderPaise - itemTotalPaise });
  }
  if (deliveryMode === "pickup" && !priced.policy.pickupEnabled) blockers.push({ code: "PICKUP_DISABLED", message: "Pickup is not available at this kitchen" });
  if (deliveryMode === "delivery") {
    if (!address) blockers.push({ code: "ADDRESS_REQUIRED", message: "Choose a delivery address" });
    else {
      if (!kitchenCovers(kitchen, address.latitude, address.longitude)) {
        blockers.push({ code: "ADDRESS_NOT_SERVICEABLE", message: "This kitchen does not deliver to the selected address" });
      }
    }
  }
  const codAllowed = priced.policy.codEnabled && (!priced.policy.codMaxOrderPaise || priced.bill.grandTotalPaise <= priced.policy.codMaxOrderPaise);
  if (paymentMethod === "cod" && !codAllowed) blockers.push({ code: "COD_NOT_ALLOWED", message: "Cash on delivery is not available for this order" });
  if (coupon && !coupon.valid) blockers.push({ code: "COUPON_INVALID", message: coupon.message, soft: true });

  return {
    cartId: String(cart._id),
    kitchen: { kitchenId: String(kitchen._id), name: kitchen.name, isOpenNow: state.canOrder, message: state.message },
    items: lines.map((line) => ({ ...line, optionsText: optionsText(line) })),
    itemCount: orderable.reduce((sum, line) => sum + line.qty, 0),
    coupon,
    bill: priced.bill,
    billLines: billLines(priced.bill, coupon),
    savingsMessage: priced.bill.savingsPaise > 0 ? `You're saving ${rupees(priced.bill.savingsPaise)} on this order!` : null,
    freeDeliveryMessage: priced.bill.amountToFreeDeliveryPaise > 0 ? `Add ${rupees(priced.bill.amountToFreeDeliveryPaise)} more for free delivery` : null,
    etaLabel: deliveryMode === "pickup" ? `Ready in ${priced.etaMinutes} min` : `${priced.etaMinutes} min`,
    delivery: slot
      ? { type: "scheduled", scheduledFor: slot.startsAt, label: slot.label }
      : { type: "asap", scheduledFor: null, label: deliveryMode === "pickup" ? `Pickup in ${priced.etaMinutes} min` : `${priced.etaMinutes} min (Today)` },
    points: priced.points,
    tip: priced.tip,
    etaMinutes: priced.etaMinutes,
    distanceKm: priced.distanceKm,
    deliveryMode,
    tipPaise: priced.bill.tipPaise,
    usePoints: Boolean(usePoints),
    chefNote: cart.chefNote || null,
    address: address ? addressSnapshot(address) : null,
    paymentMethods: PAYMENT_METHODS.map((method) => ({
      method,
      ...PAYMENT_LABELS[method],
      enabled: method === "cod" ? codAllowed : true,
      note: method === "cod" && !codAllowed ? (priced.policy.codEnabled ? `Up to ₹${Math.round(priced.policy.codMaxOrderPaise / 100)}` : "Not available") : null,
    })),
    canCheckout: !blockers.some((blocker) => !blocker.soft),
    blockers,
    updatedAt: cart.updatedAt,
  };
}

/**
 * The floating cart bar on home, without pricing the whole cart: item count,
 * subtotal (prices as added), and how much more unlocks free delivery at the
 * kitchen serving the customer. `fromOtherKitchen` = the cart was filled at a
 * different kitchen than the one serving this location now.
 */
export async function cartSummary(userId, { kitchenId = null, freeDeliveryAbovePaise = null, minOrderPaise = 0, deliveryAlwaysFree = false } = {}) {
  const cart = await Cart.findOne({ user: userId }).lean();
  if (!cart?.items?.length) {
    return { itemCount: 0, kitchenId: null, subtotalPaise: 0, freeDeliveryAbovePaise, amountToFreeDeliveryPaise: deliveryAlwaysFree ? 0 : freeDeliveryAbovePaise, deliveryAlwaysFree, amountToMinOrderPaise: minOrderPaise || 0, fromOtherKitchen: false, updatedAt: null };
  }
  const subtotalPaise = cart.items.reduce((sum, line) => sum + (line.seenUnitPricePaise || 0) * line.qty, 0);
  const cartKitchen = cart.kitchen ? String(cart.kitchen) : null;
  return {
    itemCount: cart.items.reduce((sum, line) => sum + line.qty, 0),
    kitchenId: cartKitchen,
    subtotalPaise,
    freeDeliveryAbovePaise,
    amountToFreeDeliveryPaise: deliveryAlwaysFree ? 0 : freeDeliveryAbovePaise ? Math.max(0, freeDeliveryAbovePaise - subtotalPaise) : null,
    deliveryAlwaysFree,
    amountToMinOrderPaise: Math.max(0, (minOrderPaise || 0) - subtotalPaise),
    fromOtherKitchen: Boolean(kitchenId && cartKitchen && cartKitchen !== String(kitchenId)),
    updatedAt: cart.updatedAt,
  };
}

async function saveAndBuild(cart, userId, event = true, user = null) {
  await cart.save();
  if (event) {
    await publishEventSafe("cart.updated", { userId: String(userId), kitchenId: cart.kitchen ? String(cart.kitchen) : null, itemCount: cart.items.reduce((sum, line) => sum + line.qty, 0) }, { aggregate: { type: "cart", id: cart._id } });
  }
  return buildCart(userId, {}, { cart, user });
}

export async function addItem(userId, input, { user = null } = {}) {
  let kitchenId;
  let line;
  if (input.comboId) {
    const combo = await KitchenCombo.findOne({ _id: objectId(input.comboId, "combo ID"), isActive: true, approvalStatus: "live" }).lean();
    if (!combo) throw new AppError(404, "Combo not found");
    const comboDishes = await KitchenDish.find({ _id: { $in: (combo.items || []).map((item) => item.dish) } }).lean();
    const blocked = (combo.items || []).map((item) => comboDishes.find((dish) => String(dish._id) === String(item.dish))).find((dish) => !isOrderable(dish));
    if (!combo.isAvailable || blocked !== undefined) throw new AppError(409, `${combo.title} is not available right now`);
    kitchenId = String(combo.kitchen);
    line = { kind: "combo", combo: combo._id, qty: input.qty || 1, seenUnitPricePaise: combo.pricePaise };
  } else {
    const dish = await KitchenDish.findOne({ _id: objectId(input.dishId, "dish ID"), isActive: true, approvalStatus: "live" }).lean();
    if (!dish) throw new AppError(404, "Dish not found");
    const reason = unavailableReason(dish);
    if (reason) throw new AppError(409, `${dish.name}: ${unavailableMessage(dish, reason)}`);
    if (input.portionId && !(dish.portions || []).some((portion) => portion.portionId === input.portionId)) throw new AppError(422, "Choose a valid portion");
    const { chosen, errors } = chosenOptions(dish, input.optionIds || []);
    if (errors.length) throw new AppError(422, "Validation failed", errors.map((message) => ({ field: "optionIds", message })));
    kitchenId = String(dish.kitchen);
    const portion = (dish.portions || []).find((item) => item.portionId === input.portionId);
    const unit = (portion ? portion.pricePaise : dish.pricePaise) + (input.mealUpgrade && dish.mealUpgrade?.label ? dish.mealUpgrade.pricePaise || 0 : 0) + chosen.reduce((sum, option) => sum + option.pricePaise, 0);
    line = {
      kind: "dish",
      dish: dish._id,
      qty: input.qty || 1,
      portionId: input.portionId || (dish.portions || []).find((item) => item.isDefault)?.portionId || null,
      mealUpgrade: Boolean(input.mealUpgrade),
      optionIds: input.optionIds || [],
      specialInstructions: input.specialInstructions || null,
      seenUnitPricePaise: unit,
    };
  }

  return mutateCart(userId, (cart) => {
    if (cart.kitchen && cart.items.length && String(cart.kitchen) !== kitchenId) {
      if (!input.replaceCart) {
        throw new AppError(409, "Your cart has items from another kitchen. Replace them?", [{ field: "cart", message: "CART_KITCHEN_MISMATCH" }]);
      }
      cart.items = [];
      cart.couponCode = null;
    }
    cart.kitchen = kitchenId;
    const key = lineKey(line);
    const existing = cart.items.find((item) => lineKey(item) === key);
    if (existing) {
      existing.qty = Math.min(50, existing.qty + line.qty);
      if (line.specialInstructions) existing.specialInstructions = line.specialInstructions;
    } else {
      if (cart.items.length >= 40) throw new AppError(409, "Your cart is full");
      cart.items.push({ ...line, lineId: crypto.randomBytes(6).toString("hex") });
    }
  }, { user });
}

export async function updateItem(userId, lineId, { qty, specialInstructions, optionIds, portionId, mealUpgrade }, { user = null } = {}) {
  const current = (await getCart(userId)).items.find((item) => item.lineId === lineId);
  if (!current) throw new AppError(404, "Cart item not found");
  // Validate new choices against the dish before touching the cart.
  let dish = null;
  if (current.kind === "dish" && qty !== 0 && (optionIds !== undefined || portionId !== undefined || mealUpgrade !== undefined)) {
    dish = await KitchenDish.findById(current.dish).lean();
    if (!dish) throw new AppError(404, "Dish not found");
    if (optionIds !== undefined) {
      const { errors } = chosenOptions(dish, optionIds);
      if (errors.length) throw new AppError(422, "Validation failed", errors.map((message) => ({ field: "optionIds", message })));
    }
    if (portionId && !(dish.portions || []).some((portion) => portion.portionId === portionId)) {
      throw new AppError(422, "Choose a valid portion", [{ field: "portionId", message: "Choose a valid portion" }]);
    }
    if (mealUpgrade && !dish.mealUpgrade?.label) throw new AppError(422, "This dish has no meal upgrade", [{ field: "mealUpgrade", message: "This dish has no meal upgrade" }]);
  }
  return mutateCart(userId, (cart) => {
    const line = cart.items.find((item) => item.lineId === lineId);
    if (!line) throw new AppError(404, "Cart item not found");
    if (qty === 0) {
      cart.items = cart.items.filter((item) => item.lineId !== lineId);
    } else {
      if (qty != null) line.qty = qty;
      if (specialInstructions !== undefined) line.specialInstructions = specialInstructions || null;
      if (dish) {
        if (optionIds !== undefined) line.optionIds = optionIds;
        if (portionId !== undefined) line.portionId = portionId || (dish.portions || []).find((item) => item.isDefault)?.portionId || null;
        if (mealUpgrade !== undefined) line.mealUpgrade = Boolean(mealUpgrade);
        // Same choices as another line now: merge them into one line.
        const twin = cart.items.find((item) => item !== line && lineKey(item) === lineKey(line));
        if (twin) {
          twin.qty = Math.min(50, twin.qty + line.qty);
          cart.items = cart.items.filter((item) => item !== line);
        }
      }
    }
    if (!cart.items.length) cart.couponCode = null;
  }, { user });
}

export async function removeItem(userId, lineId, options = {}) {
  return updateItem(userId, lineId, { qty: 0 }, options);
}

export async function clearCart(userId) {
  // $inc __v: a save still holding the old cart must not undo the clear.
  await Cart.updateOne({ user: userId }, { $set: { items: [], couponCode: null, kitchen: null, usePoints: false, tipPaise: 0, chefNote: null }, $inc: { __v: 1 } });
  return buildCart(userId);
}

export async function updateCart(userId, input, { user = null } = {}) {
  if (input.addressId) {
    const address = await Address.findOne({ _id: objectId(input.addressId, "address ID"), user: userId, deletedAt: null }).lean();
    if (!address) throw new AppError(404, "Address not found");
  }
  return mutateCart(userId, (cart) => {
    if (input.tipPaise !== undefined) cart.tipPaise = input.tipPaise;
    if (input.usePoints !== undefined) cart.usePoints = Boolean(input.usePoints);
    if (input.chefNote !== undefined) cart.chefNote = input.chefNote || null;
    if (input.deliveryMode !== undefined) cart.deliveryMode = input.deliveryMode;
    if (input.addressId !== undefined) cart.address = input.addressId || null;
    if (input.scheduledFor !== undefined) cart.scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
  }, { event: false, user });
}

export async function applyPromo(userId, code) {
  const cart = await getCart(userId);
  if (!cart.items.length) throw new AppError(409, "Add items before applying an offer");
  const view = await buildCart(userId);
  const kitchen = await Kitchen.findById(cart.kitchen).lean();
  const itemTotalPaise = view.items.filter((line) => line.isAvailable).reduce((sum, line) => sum + line.totalPaise, 0);
  const { result } = await checkCode(code, { userId, kitchenId: cart.kitchen, city: kitchen?.city, itemTotalPaise });
  if (!result.valid) throw new AppError(422, result.message, [{ field: "code", message: result.reason }]);
  const couponCode = String(code).trim().toUpperCase();
  await publishEventSafe("coupon.applied", { userId: String(userId), code: couponCode });
  return mutateCart(userId, (fresh) => {
    fresh.couponCode = couponCode;
  }, { event: false });
}

/** Item total of the orderable lines (what offers are checked against). */
export async function cartItemTotal(cart) {
  if (!cart?.items?.length || !cart.kitchen) return 0;
  const { dishes, combos } = await menuMaps(cart.kitchen);
  return cart.items.map((line) => priceLine(line, dishes, combos)).filter((line) => line.isAvailable).reduce((sum, line) => sum + line.totalPaise, 0);
}

export async function removePromo(userId) {
  await Cart.updateOne({ user: userId }, { $set: { couponCode: null }, $inc: { __v: 1 } });
  return buildCart(userId);
}

export async function cartRecommendations(userId) {
  const cart = await Cart.findOne({ user: userId }).lean();
  if (!cart?.kitchen) return [];
  const inCart = new Set((cart.items || []).map((item) => String(item.dish)));
  return markFavorites(userId, (await popularDishes(String(cart.kitchen), 12)).filter((dish) => !inCart.has(dish.dishId)).slice(0, 6));
}

export { PAYMENT_METHODS };
