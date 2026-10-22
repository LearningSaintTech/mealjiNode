# MealJi Testing and Verification Report

This document records the automated tests, verification scripts, and recommended regression suites evaluated for commit `306b28f866288d46b4b3c4e3b78e2b8462ac1f70`.

---

## 1. Automated Tests Executed

### Test Execution Command
```bash
npm test
# Equivalent to: node --test --test-reporter=spec
```

### Execution Results
- **Date/Time:** 2026-10-22 11:47:04 IST
- **Status:** **PASS**
- **Total Tests:** 43
- **Passed:** 43
- **Failed:** 0
- **Skipped:** 0
- **Duration:** 321.87 ms

### Test Breakdown by Suite

| Suite File | Coverage Area | Tests Run | Pass Count | Status |
|:---|:---|:---:|:---:|:---:|
| `test/fixes.test.js` | Scheduled versions, suspension survival, token revocation | 5 | 5 | ✅ PASS |
| `test/money.test.js` | Currency conversion, GST splitting, rounding | 7 | 7 | ✅ PASS |
| `test/phase1.test.js` | Bill computation, distance slabs, coupons, order states | 11 | 11 | ✅ PASS |
| `test/phase2.test.js` | Subscription servesOn, cutoffs, shifts, pause windows | 6 | 6 | ✅ PASS |
| `test/settings.test.js` | Setting definitions, scopes, validation, overrides | 7 | 7 | ✅ PASS |
| `test/theme.test.js` | Theme selection, priority, dates, and promo cards | 5 | 5 | ✅ PASS |
| `test/time.test.js` | IST time calculations, midnight wrapping, month boundaries | 4 | 4 | ✅ PASS |

---

## 2. Verification Scripts Executed

### 2.1 Postman Route Synchronization Check
```bash
npm run postman:check
# Command: node scripts/checkPostmanRoutes.js
```
- **Exit Code:** `1` (Expected notice)
- **Result:** Detected 30 newly mounted or root-aliased endpoints not yet recorded in the static Postman collection:
  - `GET /api/v1/payments/checkout/:param` (New hosted checkout)
  - `POST /api/v1/payments/verify-web` (New web verification callback)
  - `POST /api/v1/orders/:param/dev-deliver` (New development delivery endpoint)
  - Root-mounted subscription routes (`/subscription-plans`, `/subscriptions/...`)
- **Note:** In accordance with instructions not to alter existing project artifacts without approval, `npm run postman:sync` was not run destructively.

### 2.2 Automation Script (`scripts/deliver_orders.js`)
- **File:** `scripts/deliver_orders.js`
- **Execution:** Connects to MongoDB (`mongodb://127.0.0.1:27017/mealji`) and performs updates on test order IDs `6ad33cb0d780ac41ec0558ed` and `6ad3131cf3eef9e682b6b3a8`.
- **Verified Behavior:** Updates status to `delivered`, paymentStatus to `paid`, assigns mock rider "Rahul Verma", and populates 6-stage status history.

---

## 3. Recommended Regression Tests (To Be Implemented)

The following integration test suites are recommended for addition into `test/` to safeguard the new features against future regression:

### Test Suite 1: Deferred Points Settlement Lifecycle
```javascript
// test/points-lifecycle.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

test('Order placement reserves points without debiting user wallet', async () => {
  // 1. User has 100 points
  // 2. Place order using 40 points
  // 3. Assert user.pointsBalance is STILL 100
  // 4. Assert order.pointsUsed === 40 and order.pointsDeductedAt === null
});

test('Delivering order debits reserved points and records pointsDeductedAt', async () => {
  // 1. Transition order to 'delivered'
  // 2. Assert user.pointsBalance is now 60
  // 3. Assert order.pointsDeductedAt is an instanceof Date
});

test('Cancelling in-flight order releases points without creating a refund transaction', async () => {
  // 1. Order placed with 40 points
  // 2. Cancel order while status === 'placed'
  // 3. Assert no refund ledger entry is created in RewardTransaction
  // 4. Assert user.pointsBalance remains 100
});
```

### Test Suite 2: In-Flight Locked Points Protection
```javascript
test('Concurrent pricing accurately computes locked points across in-flight orders', async () => {
  // 1. User with 100 points has Order A (40 points, status: 'preparing')
  // 2. Call priceLines() for Order B
  // 3. Assert bill.points.available === 100
  // 4. Assert bill.points.lockedPoints === 40
  // 5. Assert bill.points.usable <= 60
});
```

### Test Suite 3: Free-Dish Reward Auto-Cart Injection
```javascript
test('Applying free-dish coupon to empty cart automatically adds the dish', async () => {
  // 1. Empty cart
  // 2. Call cartService.applyPromo(userId, 'REWARD-FREE-COLD-COFFEE')
  // 3. Assert cart.items.length === 1
  // 4. Assert cart.items[0].dish matches the reward dish
  // 5. Assert cart.bill.discountPaise covers the dish price
});
```

### Test Suite 4: Hosted Checkout Webhook Security
```javascript
test('POST /api/v1/payments/verify-web rejects invalid cryptographic signature', async () => {
  // 1. Send POST with forged signature
  // 2. Assert response status is 400 or 422
});
```
