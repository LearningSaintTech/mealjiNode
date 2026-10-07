import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { addIstDays, istDateKey, istDateTime, parseHhmm } from "../../common/time.js";
import { accountLimiter } from "../../infrastructure/rateLimit.js";
import { availableCoupons } from "../coupon/coupon.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { hoursOn, isOpenAt } from "../kitchen/kitchen.hours.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Cart } from "./cart.model.js";
import * as carts from "./cart.service.js";

// Cart writes are rate limited per account (bots and stuck retry loops).
const cartWriteLimiter = accountLimiter("cart", { limit: 120, windowSec: 60 });

const router = Router();
router.use(authFor(["/cart", "/promos", "/checkout", "/delivery"], authMiddleware));

router.get("/cart", asyncHandler(async (req, res) => ok(res, await carts.buildCart(req.auth.userId), "Cart fetched.")));
router.post(
  "/cart/items",
  cartWriteLimiter,
  body("dishId").optional().isMongoId(),
  body("comboId").optional().isMongoId(),
  body().custom((value) => {
    if (!value.dishId === !value.comboId) throw new Error("Send either dishId or comboId");
    return true;
  }),
  body("qty").optional().isInt({ min: 1, max: 50 }).toInt(),
  body("portionId").optional({ values: "null" }).isString().isLength({ max: 20 }),
  body("mealUpgrade").optional().isBoolean(),
  body("optionIds").optional().isArray({ max: 30 }),
  body("specialInstructions").optional({ values: "null" }).isString().isLength({ max: 200 }),
  body("replaceCart").optional().isBoolean(),
  validate,
  asyncHandler(async (req, res) => ok(res, await carts.addItem(req.auth.userId, req.body), "Added to cart.", 201)),
);
router.patch(
  "/cart/items/:lineId",
  cartWriteLimiter,
  param("lineId").isString().isLength({ min: 4, max: 40 }),
  body("qty").optional().isInt({ min: 0, max: 50 }).toInt(),
  body("specialInstructions").optional({ values: "null" }).isString().isLength({ max: 200 }),
  body("optionIds").optional().isArray({ max: 30 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await carts.updateItem(req.auth.userId, req.params.lineId, req.body), "Cart updated.")),
);
router.delete("/cart/items/:lineId", cartWriteLimiter, param("lineId").isString().isLength({ min: 4, max: 40 }), validate, asyncHandler(async (req, res) => (
  ok(res, await carts.removeItem(req.auth.userId, req.params.lineId), "Removed from cart.")
)));
router.delete("/cart", cartWriteLimiter, asyncHandler(async (req, res) => ok(res, await carts.clearCart(req.auth.userId), "Cart cleared.")));
router.patch(
  "/cart",
  cartWriteLimiter,
  body("tipPaise").optional().isInt({ min: 0, max: 100000 }).toInt(),
  body("usePoints").optional().isBoolean(),
  body("chefNote").optional({ values: "null" }).isString().isLength({ max: 300 }),
  body("deliveryMode").optional().isIn(["delivery", "pickup"]),
  body("addressId").optional({ values: "null" }).isMongoId(),
  validate,
  asyncHandler(async (req, res) => ok(res, await carts.updateCart(req.auth.userId, req.body), "Cart updated.")),
);
router.post("/cart/promo", cartWriteLimiter, body("code").isString().trim().isLength({ min: 3, max: 20 }), validate, asyncHandler(async (req, res) => (
  ok(res, await carts.applyPromo(req.auth.userId, req.body.code), "Offer applied.")
)));
router.delete("/cart/promo", asyncHandler(async (req, res) => ok(res, await carts.removePromo(req.auth.userId), "Offer removed.")));
router.get("/cart/recommendations", asyncHandler(async (req, res) => ok(res, await carts.cartRecommendations(req.auth.userId), "Recommendations fetched.")));

router.get("/promos/available", asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.auth.userId }).lean();
  const view = cart?.items?.length ? await carts.buildCart(req.auth.userId) : null;
  const kitchen = cart?.kitchen ? await Kitchen.findById(cart.kitchen).lean() : null;
  const itemTotalPaise = view ? view.items.filter((line) => line.isAvailable).reduce((sum, line) => sum + line.totalPaise, 0) : 0;
  return ok(res, await availableCoupons({ userId: req.auth.userId, kitchenId: kitchen?._id || null, city: kitchen?.city || null, itemTotalPaise }), "Offers fetched.");
}));

// The full bill for the checkout screen, for the chosen address, mode and payment method.
router.post(
  "/checkout/summary",
  body("addressId").optional({ values: "null" }).isMongoId(),
  body("deliveryMode").optional().isIn(["delivery", "pickup"]),
  body("paymentMethod").optional({ values: "null" }).isIn(carts.PAYMENT_METHODS),
  body("tipPaise").optional().isInt({ min: 0, max: 100000 }).toInt(),
  body("usePoints").optional().isBoolean(),
  validate,
  asyncHandler(async (req, res) => ok(res, await carts.buildCart(req.auth.userId, req.body), "Checkout summary.")),
);

// Delivery options: "as soon as possible" and, when enabled, half-hour windows today and tomorrow.
router.get("/delivery/slots", query("kitchenId").optional().isMongoId(), validate, asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.auth.userId }).lean();
  const kitchenId = req.query.kitchenId || (cart?.kitchen ? String(cart.kitchen) : null);
  const kitchen = kitchenId ? await Kitchen.findById(kitchenId).lean() : null;
  const app = (await resolveSetting("app")).values;
  const now = new Date();
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
        const at = istDateTime(dateKey, from);
        if (at.getTime() < now.getTime() + 45 * 60 * 1000) continue;
        scheduled.push({ date: dateKey, from, startsAt: at, label: `${offset ? "Tomorrow" : "Today"} ${from}` });
      }
    }
  }
  return ok(res, { options, scheduled, scheduledEnabled: Boolean(app.featureScheduledDelivery) }, "Delivery slots fetched.");
}));

export default router;
