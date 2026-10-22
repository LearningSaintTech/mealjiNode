# MealJi Database Change Reference

This document details the MongoDB schema, query patterns, and data integrity modifications introduced in commit `306b28f866288d46b4b3c4e3b78e2b8462ac1f70`.

---

## 1. Schema Modifications

### Collection: `orders` (Mongoose Model: `Order`)

**File:** `src/modules/order/order.model.js`

#### New Field Definition
```javascript
// src/modules/order/order.model.js (Line 61)
const orderSchema = new mongoose.Schema(
  {
    ...
    pointsUsed: { type: Number, default: 0 },
    pointsDeductedAt: { type: Date, default: null }, // <-- NEW FIELD
    paymentMethod: { type: String, required: true },
    ...
  }
);
```

#### Field Specifications

| Property | Value | Notes |
|:---|:---|:---|
| **Field Name** | `pointsDeductedAt` | Tracks the physical deduction event timestamp |
| **BSON Type** | `Date` (ISODate) | Standard MongoDB date |
| **Default Value** | `null` | Initial state when order is placed |
| **Required** | `false` | Nullable |
| **Mutability** | Written once on `delivered` | Set to `new Date()` upon transition to `delivered` |
| **Backward Compatibility** | 100% Compatible | Existing records without this field evaluate to `null` |

---

## 2. Query Pattern Changes

### 2.1 In-Flight Locked Points Computation

**Affected Modules:**
- `src/modules/pricing/pricing.service.js`
- `src/modules/rewards/rewards.service.js`

#### Query Specification
```javascript
const activeOrders = await Order.find({
  user: userId,
  status: { 
    $in: [
      "payment_pending", 
      "placed", 
      "accepted", 
      "preparing", 
      "ready", 
      "dispatched"
    ] 
  },
  pointsUsed: { $gt: 0 },
  pointsDeductedAt: null,
}).select("pointsUsed orderNumber").lean();

const lockedPoints = activeOrders.reduce((sum, o) => sum + (o.pointsUsed || 0), 0);
```

#### Query Characteristics & Indexing
- **Filters:**
  - `user`: Filtered by customer ObjectId (`Indexed`).
  - `status`: Bounded list of non-terminal order states.
  - `pointsUsed`: Greater than 0.
  - `pointsDeductedAt`: Null check.
- **Index Recommendations:**
  The `orders` collection already contains an index on `{ user: 1, createdAt: -1 }`. For high-volume production deployments with heavy active order volumes, a compound partial index can further optimize this query:
  ```javascript
  db.orders.createIndex(
    { user: 1, status: 1 },
    { partialFilterExpression: { pointsUsed: { $gt: 0 }, pointsDeductedAt: null } }
  );
  ```

---

### 2.2 Terminal Delivery Points Finalization

**File:** `src/modules/order/order.service.js`

#### Update Operation
```javascript
await Order.updateOne(
  { _id: order._id },
  { $set: { pointsDeductedAt: new Date() } }
);
```
- **Atomicity:** Single-document update guarantees atomic state transition.
- **Deduplication:** Guarded by `order.pointsUsed > 0 && !order.pointsDeductedAt` to prevent duplicate ledger transactions if `afterTransition()` is invoked multiple times.

---

### 2.3 Reward Redemption Status Transition

**File:** `src/modules/order/order.service.js`  
**Collection:** `reward_redemptions` (Model: `RewardRedemption`)

#### Query & Mutation
```javascript
const redemption = await RewardRedemption.findOne({
  couponCode: order.couponCode,
  user: order.user,
  status: { $in: ["issued", "reserved"] },
});
if (redemption) {
  redemption.status = "used";
  await redemption.save();
}
```
- **Lifecycle Transition:** Transitions from `issued` $\rightarrow$ `used` when the order carrying the reward coupon is confirmed as delivered.

---

### 2.4 Auto-Add Dish Lookup for Free-Dish Coupons

**File:** `src/modules/cart/cart.service.js`  
**Collections:** `kitchen_dishes`, `coupons`

#### Query Pattern
When a user applies a free-dish coupon to an empty cart:
1. `Coupon.findOne({ code: cleanCode, isActive: true, approvalStatus: "live" }).lean()`
2. Locates matching dish:
   ```javascript
   // Match 1: In the cart's selected kitchen
   KitchenDish.findOne({ 
     kitchen: cart.kitchen, 
     name: foundCoupon.dishName, 
     isActive: true, 
     approvalStatus: "live" 
   }).select("_id").lean()
   
   // Match 2: Original reward dish
   KitchenDish.findById(foundCoupon.dish).select("kitchen name isActive approvalStatus").lean()
   
   // Match 3: Any active dish with identical name
   KitchenDish.findOne({ 
     name: foundCoupon.dishName, 
     isActive: true, 
     approvalStatus: "live" 
   }).select("_id").lean()
   ```

---

## 3. Collections Involved

| Collection Name | Mongoose Model | Operation Type | Description |
|:---|:---|:---:|:---|
| `orders` | `Order` | Read / Update | Stores `pointsDeductedAt`, queries active in-flight orders |
| `users` | `User` | Read / Update | Source of `pointsBalance` |
| `payments` | `Payment` | Read / Update | Lookups for hosted checkout sessions and verification |
| `reward_redemptions` | `RewardRedemption` | Read / Update | Coupon lifecycle finalization on delivery |
| `reward_transactions` | `RewardTransaction` | Insert | Ledger entries written by `spendPoints()` upon delivery |
| `kitchen_dishes` | `KitchenDish` | Read | Dish resolution for free-dish rewards |
| `coupons` | `Coupon` | Read | Reward coupon metadata and discount calculation |
| `subscriptions` | `Subscription` | Read | Fallback lookup for payment verification |
| `kitchen_categories` | `KitchenCategory` | Read | Global category fallback query |

---

## 4. Migrations & Backward Compatibility

### Existing Data Compatibility
- Existing orders in MongoDB created before this commit lack the `pointsDeductedAt` field.
- In JavaScript, `order.pointsDeductedAt` evaluates to `undefined` or `null`.
- Existing delivered orders will not have their points re-deducted because they are already in the terminal state `delivered` and `afterTransition()` is only triggered on state *changes*.

### Data Migration Script (Optional)
For historical reporting consistency, a one-time backfill script can populate `pointsDeductedAt` on previously delivered orders:
```javascript
// Migration: backfill_points_deducted_at.js
import mongoose from 'mongoose';

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  const result = await mongoose.connection.db.collection('orders').updateMany(
    { 
      status: 'delivered', 
      pointsUsed: { $gt: 0 }, 
      pointsDeductedAt: { $exists: false } 
    },
    [
      { $set: { pointsDeductedAt: "$deliveredAt" } }
    ]
  );
  console.log('Migrated orders:', result.modifiedCount);
  await mongoose.disconnect();
}
```

---

## 5. Rollback Considerations

If commit `306b28f` is reverted:
1. **Schema Safety:** The presence of `pointsDeductedAt` in existing MongoDB documents will have zero impact on the previous codebase, as Mongoose schemas ignore unmapped fields by default (strict mode).
2. **Point Balances:** In-flight orders that were created under the new model (where points were reserved but not deducted) must be settled before rolling back, or users could retain their unreserved balance upon delivery under the old codebase.
