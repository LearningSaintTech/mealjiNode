import crypto from "node:crypto";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { Address, addressSnapshot } from "../address/address.model.js";
import { isOrderable, popularDishes } from "../catalog/catalog.service.js";
import { KitchenCombo, KitchenDish } from "../catalog/catalog.model.js";
import { checkCode } from "../coupon/coupon.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { orderingState } from "../kitchen/kitchen.hours.js";
import { priceLines } from "../pricing/pricing.service.js";
import { kitchenForPoint } from "../serviceability/serviceability.service.js";
import { User } from "../user/user.model.js";
import { Cart } from "./cart.model.js";

const PAYMENT_METHODS = ["upi", "card", "netbanking", "wallet", "cod"];

const lineKey = (line) => [line.kind, String(line.dish || line.combo), line.portionId || "", line.mealUpgrade ? 1 : 0, [...(line.optionIds || [])].sort().join(",")].join("|");

async function getCart(userId) {
  return (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] });
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
  const original = (!portion && dish.originalPricePaise > dish.pricePaise ? dish.originalPricePaise : base) + extras;
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

async function menuMaps(items) {
  const dishIds = items.filter((item) => item.kind !== "combo").map((item) => item.dish);
  const combos = await KitchenCombo.find({ _id: { $in: items.filter((item) => item.kind === "combo").map((item) => item.combo) } }).lean();
  const comboDishIds = combos.flatMap((combo) => (combo.items || []).map((item) => item.dish));
  const dishes = await KitchenDish.find({ _id: { $in: [...dishIds, ...comboDishIds] } }).lean();
  return { dishes: new Map(dishes.map((dish) => [String(dish._id), dish])), combos: new Map(combos.map((combo) => [String(combo._id), combo])) };
}

/**
 * The full priced cart / checkout summary. Everything money-related comes from
 * the server: lines re-priced from the live menu, the bill from the kitchen's
 * pricing and tax settings, the coupon re-validated, points capped, plus the
 * reasons checkout is blocked (if any).
 */
export async function buildCart(userId, overrides = {}) {
  const cart = await getCart(userId);
  const user = await User.findById(userId).lean();
  const deliveryMode = overrides.deliveryMode || cart.deliveryMode || "delivery";
  const tipPaise = overrides.tipPaise ?? cart.tipPaise ?? 0;
  const usePoints = overrides.usePoints ?? cart.usePoints ?? false;
  const paymentMethod = overrides.paymentMethod || null;
  const addressId = overrides.addressId || (cart.address ? String(cart.address) : null);

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

  const kitchen = await Kitchen.findById(cart.kitchen).lean();
  if (!kitchen) return empty;
  const { dishes, combos } = await menuMaps(cart.items);
  const now = new Date();
  const lines = cart.items.map((line) => priceLine(line, dishes, combos, now));
  const orderable = lines.filter((line) => line.isAvailable);
  const itemTotalPaise = orderable.reduce((sum, line) => sum + line.totalPaise, 0);

  let address = null;
  if (deliveryMode === "delivery" && addressId) {
    address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: userId, deletedAt: null }).lean();
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
  if (!state.canOrder) blockers.push({ code: "KITCHEN_CLOSED", message: state.message, opensAt: state.opensAt || null });
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
      const match = await kitchenForPoint(address.latitude, address.longitude);
      if (!match || String(match.kitchen._id) !== String(kitchen._id)) {
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
    items: lines,
    itemCount: orderable.reduce((sum, line) => sum + line.qty, 0),
    coupon,
    bill: priced.bill,
    points: priced.points,
    tip: priced.tip,
    etaMinutes: priced.etaMinutes,
    distanceKm: priced.distanceKm,
    deliveryMode,
    tipPaise: priced.bill.tipPaise,
    usePoints: Boolean(usePoints),
    chefNote: cart.chefNote || null,
    address: address ? addressSnapshot(address) : null,
    paymentMethods: PAYMENT_METHODS.filter((method) => method !== "wallet").map((method) => ({
      method,
      enabled: method === "cod" ? codAllowed : true,
      note: method === "cod" && !codAllowed ? (priced.policy.codEnabled ? `Up to ₹${Math.round(priced.policy.codMaxOrderPaise / 100)}` : "Not available") : null,
    })),
    canCheckout: !blockers.some((blocker) => !blocker.soft),
    blockers,
    updatedAt: cart.updatedAt,
  };
}

export async function cartSummary(userId) {
  const cart = await Cart.findOne({ user: userId }).lean();
  if (!cart?.items?.length) return { itemCount: 0, kitchenId: null };
  return { itemCount: cart.items.reduce((sum, line) => sum + line.qty, 0), kitchenId: cart.kitchen ? String(cart.kitchen) : null, updatedAt: cart.updatedAt };
}

async function saveAndBuild(cart, userId, event = true) {
  await cart.save();
  if (event) {
    await publishEventSafe("cart.updated", { userId: String(userId), kitchenId: cart.kitchen ? String(cart.kitchen) : null, itemCount: cart.items.reduce((sum, line) => sum + line.qty, 0) }, { aggregate: { type: "cart", id: cart._id } });
  }
  return buildCart(userId);
}

export async function addItem(userId, input) {
  const cart = await getCart(userId);
  let kitchenId;
  let line;
  if (input.comboId) {
    const combo = await KitchenCombo.findOne({ _id: objectId(input.comboId, "combo ID"), isActive: true, approvalStatus: "live" }).lean();
    if (!combo) throw new AppError(404, "Combo not found");
    kitchenId = String(combo.kitchen);
    line = { kind: "combo", combo: combo._id, qty: input.qty || 1, seenUnitPricePaise: combo.pricePaise };
  } else {
    const dish = await KitchenDish.findOne({ _id: objectId(input.dishId, "dish ID"), isActive: true, approvalStatus: "live" }).lean();
    if (!dish) throw new AppError(404, "Dish not found");
    if (!isOrderable(dish)) throw new AppError(409, `${dish.name} is sold out right now`);
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
  return saveAndBuild(cart, userId);
}

export async function updateItem(userId, lineId, { qty, specialInstructions, optionIds, portionId, mealUpgrade }) {
  const cart = await getCart(userId);
  const line = cart.items.find((item) => item.lineId === lineId);
  if (!line) throw new AppError(404, "Cart item not found");
  if (qty === 0) {
    cart.items = cart.items.filter((item) => item.lineId !== lineId);
  } else {
    if (qty != null) line.qty = qty;
    if (specialInstructions !== undefined) line.specialInstructions = specialInstructions || null;
    if (line.kind === "dish" && (optionIds !== undefined || portionId !== undefined || mealUpgrade !== undefined)) {
      const dish = await KitchenDish.findById(line.dish).lean();
      if (!dish) throw new AppError(404, "Dish not found");
      if (optionIds !== undefined) {
        const { errors } = chosenOptions(dish, optionIds);
        if (errors.length) throw new AppError(422, "Validation failed", errors.map((message) => ({ field: "optionIds", message })));
        line.optionIds = optionIds;
      }
      if (portionId !== undefined) line.portionId = portionId;
      if (mealUpgrade !== undefined) line.mealUpgrade = Boolean(mealUpgrade);
    }
  }
  if (!cart.items.length) cart.couponCode = null;
  return saveAndBuild(cart, userId);
}

export async function removeItem(userId, lineId) {
  return updateItem(userId, lineId, { qty: 0 });
}

export async function clearCart(userId) {
  await Cart.updateOne({ user: userId }, { $set: { items: [], couponCode: null, kitchen: null, usePoints: false, tipPaise: 0, chefNote: null } });
  return buildCart(userId);
}

export async function updateCart(userId, input) {
  const cart = await getCart(userId);
  if (input.tipPaise !== undefined) cart.tipPaise = input.tipPaise;
  if (input.usePoints !== undefined) cart.usePoints = Boolean(input.usePoints);
  if (input.chefNote !== undefined) cart.chefNote = input.chefNote || null;
  if (input.deliveryMode !== undefined) cart.deliveryMode = input.deliveryMode;
  if (input.addressId !== undefined) {
    if (input.addressId) {
      const address = await Address.findOne({ _id: objectId(input.addressId, "address ID"), user: userId, deletedAt: null }).lean();
      if (!address) throw new AppError(404, "Address not found");
    }
    cart.address = input.addressId || null;
  }
  return saveAndBuild(cart, userId, false);
}

export async function applyPromo(userId, code) {
  const cart = await getCart(userId);
  if (!cart.items.length) throw new AppError(409, "Add items before applying an offer");
  const view = await buildCart(userId);
  const kitchen = await Kitchen.findById(cart.kitchen).lean();
  const itemTotalPaise = view.items.filter((line) => line.isAvailable).reduce((sum, line) => sum + line.totalPaise, 0);
  const { result } = await checkCode(code, { userId, kitchenId: cart.kitchen, city: kitchen?.city, itemTotalPaise });
  if (!result.valid) throw new AppError(422, result.message, [{ field: "code", message: result.reason }]);
  cart.couponCode = String(code).trim().toUpperCase();
  await publishEventSafe("coupon.applied", { userId: String(userId), code: cart.couponCode });
  return saveAndBuild(cart, userId, false);
}

export async function removePromo(userId) {
  await Cart.updateOne({ user: userId }, { $set: { couponCode: null } });
  return buildCart(userId);
}

export async function cartRecommendations(userId) {
  const cart = await Cart.findOne({ user: userId }).lean();
  if (!cart?.kitchen) return [];
  const inCart = new Set((cart.items || []).map((item) => String(item.dish)));
  return (await popularDishes(String(cart.kitchen), 12)).filter((dish) => !inCart.has(dish.dishId)).slice(0, 6);
}

export { PAYMENT_METHODS };
