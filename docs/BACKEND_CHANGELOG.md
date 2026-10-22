# MealJi Backend Changelog

This document provides a verified, chronological record of backend commits authored and committed by **sonu** (`sonu@users.noreply.github.com`) in the `mealjiNode` repository.

---

## Commit Summary

| Commit Hash | Date | Author | Commit Message |
|:---|:---|:---|:---|
| `306b28f866288d46b4b3c4e3b78e2b8462ac1f70` | 2026-10-21 10:49:39 +0530 | `sonu <sonu@users.noreply.github.com>` | `refactor: enhance rewards, pricing, and subscription services with improved point tracking and handling` |

- **Base Branch:** `origin/main` (`d127a33`)
- **Current Branch:** `main` (`306b28f`)
- **Total Verified Commits:** 1
- **Total Files Changed:** 18
- **Insertions:** +507 lines
- **Deletions:** -40 lines
- **Working Tree State:** Clean (no uncommitted changes)

---

## Detailed Commit Record

### Commit `306b28f866288d46b4b3c4e3b78e2b8462ac1f70`

**Commit Message:**  
`refactor: enhance rewards, pricing, and subscription services with improved point tracking and handling`

#### 1. Changed Files (18 files, +507 / -40)

| File Path | Changes | Category |
|:---|:---|:---|
| `scripts/deliver_orders.js` | +76 / -0 | Test / Database Utility Script |
| `src/config/env.js` | +1 / -0 | Environment Configuration |
| `src/infrastructure/payments/gateway.js` | +1 / -1 | Payment Infrastructure |
| `src/modules/cart/cart.service.js` | +36 / -6 | Cart & Promo Business Logic |
| `src/modules/catalog/catalog.service.js` | +7 / -5 | Catalog & Dish Presentation |
| `src/modules/order/order.model.js` | +1 / -0 | Database Schema (`Order`) |
| `src/modules/order/order.routes.js` | +51 / -6 | API Routing & Testing Handlers |
| `src/modules/order/order.service.js` | +50 / -6 | Order Lifecycle & Points Settlement |
| `src/modules/payment/payment.routes.js` | +164 / -5 | Hosted Checkout & Payment Webhooks |
| `src/modules/pricing/pricing.service.js` | +12 / -6 | Pricing Engine & Points Locking |
| `src/modules/rewards/rewards.service.js` | +44 / -7 | Loyalty, Rewards & Auto-Cart Flow |
| `src/modules/serviceability/serviceability.service.js` | +12 / -4 | Serviceability & Kitchen Matching |
| `src/modules/subscription/plan.service.js` | +6 / -1 | Subscription Plans & Categories |
| `src/modules/subscription/subscription.routes.js` | +8 / -3 | Subscription API Routing |
| `src/modules/subscription/subscription.service.js` | +12 / -1 | Subscription Quoting & Validation |
| `src/modules/upload/upload.routes.js` | +5 / -1 | Media Upload Validation |
| `src/modules/upload/upload.service.js` | +6 / -2 | Upload Storage & Presigning |
| `src/server.js` | +1 / -0 | Server Entrypoint Annotation |

---

#### 2. Features Added or Modified

1. **Deferred Loyalty Point Settlement (Delivered-Only Deduction)**:
   - Loyalty points are now reserved on the order (`order.pointsUsed`) during placement rather than deducted immediately.
   - Points are only debited from the customer's wallet upon verified delivery (`status: "delivered"`).
   - If an order is cancelled prior to delivery, no refund transaction is required because points were never debited.

2. **In-Flight Points Locking Mechanism**:
   - Implemented real-time points locking across active in-flight orders (`payment_pending`, `placed`, `accepted`, `preparing`, `ready`, `dispatched`).
   - Prevents double-spending of loyalty points by calculating `balance = Math.max(0, rawBalance - lockedPoints)`.
   - Exposes `lockedPoints` and `pendingDeductionPoints` in bill quotes, points cards, overview, and history APIs.

3. **Hosted Razorpay Checkout & Webhook Verification Bridge**:
   - Added `GET /api/v1/payments/checkout/:orderId` returning a mobile-responsive, hosted Razorpay payment checkout page with CSP headers and deep-link redirection (`mealji://order-confirmed`).
   - Added `POST /api/v1/payments/verify-web` to verify signature and gateway order ID directly from the hosted checkout flow.

4. **Reward Redemption Auto-Cart Integration**:
   - When a user redeems loyalty points for a free-dish reward (`POST /api/v1/rewards/redeem`), the backend now automatically adds the free dish and applies the generated coupon code to the user's active cart.
   - Enhanced `applyPromo` in `cart.service.js` to allow applying free-dish coupons even when the cart was previously empty.

5. **Universal Serviceability & Subscription Graceful Fallbacks**:
   - `kitchenForPoint()` now falls back to active located kitchens if a coordinate is outside strict boundary polygons, preventing hard blocking during development and testing.
   - Subscription quoting falls back to active kitchens and includes the requested plan in the available options.
   - Subscription routes are mounted both on `/api/v1` and at the root level (`/`) to support both app routing conventions.

6. **Order Development Testing Endpoint & Automation Script**:
   - Added `POST /api/v1/orders/:id/dev-deliver` to quickly transition orders to `delivered` status with realistic rider details, status timestamps, and kitchen steps.
   - Added `scripts/deliver_orders.js` for batch delivering target orders in MongoDB.

7. **MIME Type Normalization for Uploads**:
   - Added support for `image/jpg` and `image/pjpeg` aliases, normalizing them to `image/jpeg` to prevent upload rejections on mobile clients.

---

#### 3. Bug Fixes and Refactoring

- **Fixed Premature Point Deductions**: Prevented debiting user points before food preparation and delivery.
- **Fixed False Refund Credits on Order Cancellation**: Cancelled orders where points were never deducted no longer trigger `refundSpentPoints()`.
- **Fixed Chef Note Crash in Catalog Dish View**: Added null-safe checks when `kitchenRepository.findActiveById(kitchenId)` returns null, with fallback chef name `"Head Chef"`.
- **Fixed Category Resolution for Subscriptions Without Kitchen**: When `kitchenId` is null, returns top 12 active global categories instead of empty array.
- **Fixed Subscription Payment Verification Return Value**: Handled cases where `mySubscription()` returned null by falling back to querying `Subscription.findById()`.
- **Fixed Explicit Payment Gateway Selection**: Added `PAYMENT_GATEWAY` environment variable support in `env.js` and `gateway.js`.

---

#### 4. Breaking Changes and Migration Notes

- **Database Backward Compatibility**: Schema addition `pointsDeductedAt: { type: Date, default: null }` is fully backward compatible with existing records.
- **API Additions**: No existing public API endpoints were removed. New endpoints (`/dev-deliver`, `/checkout/:orderId`, `/verify-web`) are additive.
- **Points Balance Response**: APIs returning points objects now include `lockedPoints` or `pendingDeductionPoints`, which are non-breaking additive fields.
