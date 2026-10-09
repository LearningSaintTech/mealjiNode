import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { accountLimiter } from "../../infrastructure/rateLimit.js";
import { availableCoupons } from "../coupon/coupon.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { kitchenRepository } from "../kitchen/kitchen.repository.js";
import { Cart } from "./cart.model.js";
import * as carts from "./cart.service.js";

// Cart writes are rate limited per account (bots and stuck retry loops).
const cartWriteLimiter = accountLimiter("cart", { limit: 120, windowSec: 60 });

const router = Router();
router.use(authFor(["/cart", "/promos", "/checkout", "/delivery"], authMiddleware));

router.get("/cart", asyncHandler(async (req, res) => ok(res, await carts.buildCart(req.auth.userId, {}, { user: req.auth.user }), "Cart fetched.")));
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
  asyncHandler(async (req, res) => ok(res, await carts.addItem(req.auth.userId, req.body, { user: req.auth.user }), "Added to cart.", 201)),
);
router.patch(
  "/cart/items/:lineId",
  cartWriteLimiter,
  param("lineId").isString().isLength({ min: 4, max: 40 }),
  body("qty").optional().isInt({ min: 0, max: 50 }).withMessage("Quantity is 0 to 50").toInt(),
  body("specialInstructions").optional({ values: "null" }).isString().isLength({ max: 200 }),
  body("optionIds").optional().isArray({ max: 30 }),
  body("portionId").optional({ values: "null" }).isString().isLength({ max: 20 }),
  body("mealUpgrade").optional().isBoolean().withMessage("mealUpgrade is true or false"),
  validate,
  asyncHandler(async (req, res) => ok(res, await carts.updateItem(req.auth.userId, req.params.lineId, req.body, { user: req.auth.user }), "Cart updated.")),
);
router.delete("/cart/items/:lineId", cartWriteLimiter, param("lineId").isString().isLength({ min: 4, max: 40 }), validate, asyncHandler(async (req, res) => (
  ok(res, await carts.removeItem(req.auth.userId, req.params.lineId, { user: req.auth.user }), "Removed from cart.")
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
  body("scheduledFor").optional({ values: "null" }).isISO8601().withMessage("scheduledFor is a date-time from the delivery slots"),
  validate,
  asyncHandler(async (req, res) => {
    if (req.body.scheduledFor) await assertSlot(req.auth.userId, req.body.scheduledFor);
    return ok(res, await carts.updateCart(req.auth.userId, req.body, { user: req.auth.user }), "Cart updated.");
  }),
);
router.post("/cart/promo", cartWriteLimiter, body("code").isString().trim().isLength({ min: 3, max: 20 }), validate, asyncHandler(async (req, res) => (
  ok(res, await carts.applyPromo(req.auth.userId, req.body.code), "Offer applied.")
)));
router.delete("/cart/promo", asyncHandler(async (req, res) => ok(res, await carts.removePromo(req.auth.userId), "Offer removed.")));
router.get("/cart/recommendations", asyncHandler(async (req, res) => ok(res, await carts.cartRecommendations(req.auth.userId), "Recommendations fetched.")));

router.get("/promos/available", asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.auth.userId }).lean();
  const kitchen = cart?.kitchen ? await kitchenRepository.findActiveById(cart.kitchen) : null;
  const itemTotalPaise = await carts.cartItemTotal(cart);
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
  body("scheduledFor").optional({ values: "null" }).isISO8601().withMessage("scheduledFor is a date-time from the delivery slots"),
  validate,
  asyncHandler(async (req, res) => ok(res, await carts.buildCart(req.auth.userId, req.body, { user: req.auth.user }), "Checkout summary.")),
);

// Delivery options: "as soon as possible" and, when enabled, half-hour windows today and tomorrow.
router.get("/delivery/slots", query("kitchenId").optional().isMongoId().withMessage("kitchenId is not valid"), validate, asyncHandler(async (req, res) => {
  const cart = await Cart.findOne({ user: req.auth.userId }).lean();
  const kitchenId = req.query.kitchenId || (cart?.kitchen ? String(cart.kitchen) : null);
  const kitchen = kitchenId ? await Kitchen.findById(kitchenId).lean() : null;
  return ok(res, await carts.deliverySlots(kitchen), "Delivery slots fetched.");
}));

/** A scheduled time must be one of the slots offered for the cart's kitchen right now. */
async function assertSlot(userId, scheduledFor) {
  const cart = await Cart.findOne({ user: userId }).lean();
  const kitchen = cart?.kitchen ? await Kitchen.findById(cart.kitchen).lean() : null;
  const { scheduled } = await carts.deliverySlots(kitchen);
  if (!scheduled.some((slot) => slot.startsAt.getTime() === new Date(scheduledFor).getTime())) {
    throw new AppError(422, "Choose one of the delivery times offered", [{ field: "scheduledFor", message: "Choose one of the delivery times offered" }]);
  }
}

export default router;
