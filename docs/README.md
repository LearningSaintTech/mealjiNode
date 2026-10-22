# MealJi Backend Technical Documentation Hub

Welcome to the **MealJi Node.js Backend Technical Documentation Hub**. This directory contains comprehensive architectural analysis, changelogs, API references, database specifications, and operational deployment guides for the MealJi backend service.

---

## Documentation Index

| Document | Primary Audience | Description |
|:---|:---|:---|
| **[BACKEND_CHANGELOG.md](./BACKEND_CHANGELOG.md)** | All Developers / Reviewers | Chronological commit log, author verification, changed file stats, and high-level feature list. |
| **[BACKEND_CHANGE_ANALYSIS.md](./BACKEND_CHANGE_ANALYSIS.md)** | Backend Engineers / Architects | Deep technical report: executive summary, before-vs-after comparisons, architecture, and file-by-file breakdown. |
| **[API_CHANGE_REFERENCE.md](./API_CHANGE_REFERENCE.md)** | Frontend & Mobile Engineers | Exhaustive API reference for all new and modified endpoints, query parameters, request bodies, and responses. |
| **[DATABASE_CHANGE_REFERENCE.md](./DATABASE_CHANGE_REFERENCE.md)** | Database Administrators / Backend | Schema changes (`Order.pointsDeductedAt`), query patterns, collection relationships, and rollback considerations. |
| **[DEPLOYMENT_AND_MIGRATION.md](./DEPLOYMENT_AND_MIGRATION.md)** | DevOps / SRE / Operators | Environment variables (`PAYMENT_GATEWAY`), zero-downtime deployment steps, and rollback plans. |
| **[TESTING_AND_VERIFICATION.md](./TESTING_AND_VERIFICATION.md)** | QA Engineers / Developers | Automated test execution results (43 passed tests), script verifications, and recommended regression suites. |

---

## Target Commit Overview

- **Author:** sonu (`sonu@users.noreply.github.com`)
- **Commit Hash:** `306b28f866288d46b4b3c4e3b78e2b8462ac1f70`
- **Base Commit:** `d127a33a59df76feff0f81d8985c4942ae3bfbca` (`origin/main`)
- **Files Changed:** 18 files (+507 / -40)
- **Primary Themes:**
  1. **Deferred Loyalty Points Accounting:** Points reserved during order checkout; finalized only upon physical delivery.
  2. **In-Flight Points Locking:** Prevents concurrent double-spending across active orders.
  3. **Hosted Razorpay Payment Bridge:** Mobile-responsive hosted web checkout with automatic verification.
  4. **Frictionless Reward Redemptions:** Automatic free-dish injection and coupon application to customer carts.
  5. **Universal Serviceability:** Robust fallback matching for kitchens and subscription quoting in demo/staging environments.
  6. **Media Upload Normalization:** Content-Type tolerance for `image/jpg` and `image/pjpeg`.

---

## Suggested Reading Paths

### For Backend Engineers & Code Reviewers
1. Start with **[BACKEND_CHANGE_ANALYSIS.md](./BACKEND_CHANGE_ANALYSIS.md)** for architecture and design patterns.
2. Review **[DATABASE_CHANGE_REFERENCE.md](./DATABASE_CHANGE_REFERENCE.md)** for data model changes.
3. Check **[TESTING_AND_VERIFICATION.md](./TESTING_AND_VERIFICATION.md)** for test coverage.

### For Mobile (React Native / iOS / Android) & Frontend Engineers
1. Read **[API_CHANGE_REFERENCE.md](./API_CHANGE_REFERENCE.md)** to integrate:
   - Hosted payment URLs (`checkoutUrl`).
   - New `pendingDeductionPoints` and `lockedPoints` balance fields.
   - Reward redemption auto-cart behavior.
   - Fast delivery testing via `POST /api/v1/orders/:id/dev-deliver`.

### For DevOps & Release Managers
1. Review **[DEPLOYMENT_AND_MIGRATION.md](./DEPLOYMENT_AND_MIGRATION.md)** for environment variable configuration and deployment steps.
2. Verify **[BACKEND_CHANGELOG.md](./BACKEND_CHANGELOG.md)** for commit traceability.
