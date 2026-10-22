# MealJi API Change Reference

This document provides a consolidated technical reference for all new and modified API endpoints introduced in commit `306b28f866288d46b4b3c4e3b78e2b8462ac1f70`.

---

## Quick Endpoint Navigation

| Endpoint | Method | Status | Auth Required | Description |
|:---|:---:|:---:|:---:|:---|
| [`/api/v1/payments/checkout/:orderId`](#1-get-apiv1paymentscheckoutorderid) | `GET` | **NEW** | None (Public / Tokenless) | Hosted Razorpay payment checkout web bridge page |
| [`/api/v1/payments/verify-web`](#2-post-apiv1paymentsverify-web) | `POST` | **NEW** | None (Signature-based) | Web payment verification callback from hosted checkout |
| [`/api/v1/orders/:id/dev-deliver`](#3-post-apiv1ordersiddev-deliver) | `POST` | **NEW** | Customer Auth | Dev/testing endpoint to immediately deliver an order |
| [`/api/v1/orders`](#4-post-apiv1orders) | `POST` | **MODIFIED** | Customer Auth | Order creation with deferred points and `checkoutUrl` |
| [`/subscriptions/:id/verify-payment`](#5-post-subscriptionsidverify-payment) | `POST` | **MODIFIED** | Customer Auth | Subscription payment verification with fallback |
| [`/subscription-plans` & `/api/v1/subscription-plans`](#6-get-subscription-plans) | `GET` | **MODIFIED** | Customer Auth | Universal dual-mounted subscription plans |
| [`/local/*`](#7-put-local) | `PUT` | **MODIFIED** | Signed Query Token | Binary local file upload with MIME normalization |
| [`/api/v1/uploads/presign`](#8-post-apiv1uploadspresign) | `POST` | **MODIFIED** | User Auth | Presigned upload URL generator with JPEG aliases |
| [`/api/v1/cart/promo`](#9-post-apiv1cartpromo) | `POST` | **MODIFIED** | Customer Auth | Apply promo code with auto-add dish for empty carts |
| [`/api/v1/rewards/redeem`](#10-post-apiv1rewardsredeem) | `POST` | **MODIFIED** | Customer Auth | Redeem reward with automatic cart injection |
| [`/api/v1/rewards/summary`](#11-get-apiv1rewardssummary) | `GET` | **MODIFIED** | Customer Auth | Rewards summary with `pendingDeductionPoints` |
| [`/api/v1/rewards/points-card`](#12-get-apiv1rewardspoints-card) | `GET` | **MODIFIED** | Customer Auth | Quick points card with `pendingDeductionPoints` |
| [`/api/v1/rewards/overview`](#13-get-apiv1rewardsoverview) | `GET` | **MODIFIED** | Customer Auth | Rewards overview with active `myRedemptions` |
| [`/api/v1/dishes/:id`](#14-get-apiv1dishesid) | `GET` | **MODIFIED** | Optional Auth | Customer dish view with null-safe chef resolution |

---

## 1. `GET /api/v1/payments/checkout/:orderId`

### Purpose & Business Use Case
Renders a hosted, self-contained HTML/CSS/JS payment page embedding the Razorpay standard checkout library (`checkout.js`). Used as a universal payment bridge for web clients, desktop previews, or mobile applications opening web-view based payments.

### Authentication & Authorization
- **Auth:** None required (Public access, secured by MongoDB `orderId` and order status checks).
- **Headers:** None required.

### Path Parameters
| Parameter | Type | Validation | Description |
|:---|:---:|:---:|:---|
| `orderId` | `string` | Valid Mongo ObjectId | Unique identifier of the target order |

### Execution Flow
1. Sets custom `Content-Security-Policy` header to whitelist `https://checkout.razorpay.com` and `https://api.razorpay.com`.
2. Fetches order by `orderId` via `Order.findById(orderId).lean()`.
3. If order not found, returns `404 Order not found`.
4. If `order.status !== "payment_pending"`, renders an informative card stating the order is already processed and displays a button linking to `mealji://order-confirmed?orderId=...`.
5. Queries `Payment` collection for latest session with `{ refType: "order", refId: order._id }`.
6. Extracts `gatewayOrderId`, `amountPaise`, `keyId`, and prefill data.
7. Renders styled HTML with auto-opening Razorpay checkout dialog (`setTimeout(openRazorpay, 350)`).
8. Razorpay callback invokes `/api/v1/payments/verify-web`, then redirects to `mealji://order-confirmed?orderId=...`.

### Response Structure
- **Success (200 OK):** `Content-Type: text/html; charset=utf-8` (Rendered HTML document).
- **Errors:**
  - `404 Not Found`: "Order not found" or "Payment session not found. Please retry from the app."

---

## 2. `POST /api/v1/payments/verify-web`

### Purpose & Business Use Case
Dedicated payment verification webhook endpoint called by the hosted web checkout page upon successful payment completion in the embedded Razorpay dialog.

### Authentication & Authorization
- **Auth:** None (Signature-based HMAC validation).
- **Security:** Verified cryptographically using `RAZORPAY_KEY_SECRET`.

### Request Body
```json
{
  "gatewayOrderId": "order_PvQ7B123456789",
  "gatewayPaymentId": "pay_PvQ8C987654321",
  "signature": "e5c4a7f0d1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8"
}
```

### Validation Rules
- `gatewayOrderId`: `string`, length 4–80.
- `gatewayPaymentId`: `string`, length 4–80.
- `signature`: `string`, length 10–200.

### Execution Flow
1. Middleware validates body schema via `validate`.
2. Queries `Payment.findOne({ gatewayOrderId })`. If not found, throws `404 Payment not found`.
3. Calls `payments.verifyFromApp(payment.user, { gatewayOrderId, gatewayPaymentId, signature })`.
4. Transitions payment and order status to `paid` and `placed`.
5. Returns envelope: `{ success: true, data: { orderId: "...", paymentStatus: "paid" }, message: "Payment verified." }`.

---

## 3. `POST /api/v1/orders/:id/dev-deliver`

### Purpose & Business Use Case
A developer and testing utility endpoint enabling QA engineers and developers to immediately transition an order to `delivered` status, populating realistic rider details, simulated cooking milestones, and triggering loyalty points finalization.

### Authentication & Authorization
- **Auth:** Bearer Token (`authMiddleware`, Customer Role).
- **Ownership:** Order must belong to the authenticated user (`req.auth.userId`).

### Path Parameters
| Parameter | Type | Validation | Description |
|:---|:---:|:---:|:---|
| `id` | `string` | Mongo ObjectId | Target order ID |

### Execution Flow
1. Fetches customer's order: `orders.getMyOrder(req.auth.userId, req.params.id)`.
2. Updates:
   - `order.status = "delivered"`
   - `order.paymentStatus = "paid"`
   - `order.deliveredAt = new Date()`
   - Synthesizes `placedAt` (-30m), `acceptedAt` (-25m), `readyAt` (-15m), `dispatchedAt` (-10m) if not set.
   - Populates `order.rider` (Rahul Verma, 4.9 rating, vehicle `KA 01 EK 4920`, photo).
   - Marks all `kitchenSteps` as `done`.
3. Calls `orders.afterTransition(order, previous, "delivered")` to finalize points deduction.
4. Emits `order.delivered` event via `publishEventSafe`.
5. Returns serialized order view.

### Response Example (200 OK)
```json
{
  "success": true,
  "data": {
    "orderId": "6ad33cb0d780ac41ec0558ed",
    "orderNumber": "MJ-10084",
    "status": "delivered",
    "paymentStatus": "paid",
    "deliveredAt": "2026-10-22T10:45:00.000Z",
    "rider": {
      "name": "Rahul Verma",
      "phone": "9876543210",
      "rating": 4.9,
      "vehicleNumber": "KA 01 EK 4920"
    }
  },
  "message": "Order delivered for testing."
}
```

---

## 4. `POST /api/v1/orders`

### Purpose & Business Use Case
Places a new food delivery or pickup order from the customer's current cart.

### Key Modifications in Commit `306b28f`
1. **Deferred Loyalty Points:** Does not deduct points from the user's account balance. Points are stored in `pointsUsed` as a reservation.
2. **`checkoutUrl` In Response:** Payment data returned inside the order creation envelope now includes:
   ```json
   "payment": {
     "gatewayOrderId": "order_Q1234567890",
     "amount": 10400,
     "currency": "INR",
     "keyId": "rzp_test_...",
     "checkoutUrl": "http://127.0.0.1:4000/api/v1/payments/checkout/6ad33cb0d780ac41ec0558ed"
   }
   ```
3. **Structured Server Logging:** Logs request payload, grand total, and response summary for instant terminal observability.

---

## 5. `POST /subscriptions/:id/verify-payment`

### Purpose & Business Use Case
Verifies the payment for a Meal Ji Plus subscription.

### Key Modifications in Commit `306b28f`
- Added fallback lookup: If `mySubscription(userId).subscription` is null (e.g. state transition latency in MongoDB), falls back to directly executing `Subscription.findById(req.params.id).lean()`.
- Prevents null pointer errors and ensures the client receives the active subscription representation immediately.

---

## 6. `GET /subscription-plans` & `GET /api/v1/subscription-plans`

### Purpose & Business Use Case
Retrieves available Meal Ji Plus subscription plans for the customer's current location or kitchen.

### Key Modifications in Commit `306b28f`
1. **Dual Route Mounting:** Mounted at both `/subscription-plans` and `/api/v1/subscription-plans`.
2. **Resilient Kitchen Resolution:** Uses `.catch(() => null)` when resolving customer kitchen, so users without a saved address or selected kitchen can still browse subscription plans.
3. **Global Category Fallback:** If `kitchenId` is null, returns top 12 active `KitchenCategory` records instead of an empty array.

---

## 7. `PUT /local/*`

### Purpose & Business Use Case
Binary direct upload handler for local storage mode.

### Key Modifications in Commit `306b28f`
- Inspects `Content-Type` header:
  - Strips parameter suffixes (e.g. `image/jpeg; charset=utf-8` $\rightarrow$ `image/jpeg`).
  - Normalizes `image/jpg` and `image/pjpeg` to `image/jpeg`.
- Prevents upload failures caused by mobile device photo picker headers.

---

## 8. `POST /api/v1/uploads/presign`

### Purpose & Business Use Case
Generates a presigned upload URL and temporary token for customer or admin media uploads (profile photos, ticket attachments).

### Key Modifications in Commit `306b28f`
- Added `"image/jpg": "jpg"` to supported extension mappings.
- Normalizes incoming `contentType` to `image/jpeg` before validation against `UPLOAD_PURPOSES`.

---

## 9. `POST /api/v1/cart/promo`

### Purpose & Business Use Case
Applies a promo code or reward redemption coupon to the customer's active cart.

### Key Modifications in Commit `306b28f`
- Supports applying free-dish reward coupons when the cart is initially **empty**:
  - Automatically finds the dish referenced by `coupon.dish`.
  - Automatically calls `addItem(userId, { dishId, qty: 1, replaceCart: true })`.
  - Re-runs validation and applies the 100% discount.

---

## 10. `POST /api/v1/rewards/redeem`

### Purpose & Business Use Case
Redeems customer loyalty points for catalog rewards (free dishes, discounts).

### Key Modifications in Commit `306b28f`
- Automatically invokes `cart.applyPromo(userId, code)` upon issuing the coupon.
- Adds `addedToCart: true/false` to the response envelope.
- Updates `howToUse` instructional text:
  ```json
  {
    "success": true,
    "data": {
      "redemptionId": "6ad40123...",
      "couponCode": "REWARD-FREE-COLD-COFFEE",
      "addedToCart": true,
      "howToUse": "Cold Coffee has been added to your cart for free!"
    }
  }
  ```

---

## 11. `GET /api/v1/rewards/summary` & `GET /api/v1/rewards/points-card`

### Purpose & Business Use Case
Provides loyalty point balances and tier status.

### Key Modifications in Commit `306b28f`
- Computes `pendingDeductionPoints` across active in-flight orders.
- Response payload:
  ```json
  {
    "enabled": true,
    "points": 120,
    "pendingDeductionPoints": 40,
    "valuePaise": 3000,
    "pointValuePaise": 25,
    "tier": "silver"
  }
  ```

---

## 12. `GET /api/v1/rewards/overview`

### Purpose & Business Use Case
Single-call rewards dashboard view (points card, available rewards, earn methods, and active coupons).

### Key Modifications in Commit `306b28f`
- Appends `myRedemptions: redemptions.filter(r => r.status === "issued")`.
- Exposes user's unspent reward coupons directly in the rewards tab.

---

## 13. `GET /api/v1/dishes/:id`

### Purpose & Business Use Case
Retrieves customer dish details including story, allergens, and kitchen information.

### Key Modifications in Commit `306b28f`
- Null-safe kitchen lookup: `kitchenId ? await kitchenRepository.findActiveById(kitchenId) : null`.
- Fallback chef name `"Head Chef"` if kitchen has no explicit chef name configured.
- Omits chef card gracefully (`view.chef = null`) when the dish has no story.
