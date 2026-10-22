# MealJi Deployment and Migration Guide

This document provides operational instructions, environment variable specifications, and deployment steps for deploying commit `306b28f866288d46b4b3c4e3b78e2b8462ac1f70`.

---

## 1. Environment Variables & Configuration

### New Environment Variable

| Variable Name | Type | Allowed Values | Default Behavior | Purpose |
|:---|:---:|:---:|:---:|:---|
| `PAYMENT_GATEWAY` | `string` | `"razorpay"`, `"test"` | Auto-detect based on `RAZORPAY_KEY_ID` | Explicitly sets the active payment gateway driver in `gateway.js`. |

### Related Environment Variables

| Variable Name | Purpose | Production Requirement |
|:---|:---|:---:|
| `RAZORPAY_KEY_ID` | Razorpay API public key ID | Required if `PAYMENT_GATEWAY=razorpay` |
| `RAZORPAY_KEY_SECRET` | Razorpay API secret key | Required if `PAYMENT_GATEWAY=razorpay` |
| `RAZORPAY_WEBHOOK_SECRET` | Secret used to verify webhook signatures | Required for live webhooks |
| `PUBLIC_BASE_URL` | Base URL used to construct `checkoutUrl` | Required (e.g. `https://api.mealji.com`) |

> [!IMPORTANT]
> Never commit actual credentials, secret keys, or `.env` files into source control. All production values must be provisioned via secret managers (AWS Secrets Manager, Doppler, or Kubernetes Secrets).

---

## 2. Dependency Changes

- **New Dependencies Added:** `0` (None)
- **Dependencies Removed:** `0` (None)
- **Version Updates:** `0` (None)

The application continues to use existing dependencies (`express ^4.21.2`, `mongoose ^8.19.1`, `bullmq ^5.81.5`, `ioredis ^5.8.1`, `pino ^9.11.0`).

---

## 3. Database Migration Requirements

- **Breaking Schema Changes:** None.
- **Mandatory Migrations:** None.
- **Backward Compatibility:** 100%. The new field `pointsDeductedAt` on the `Order` model defaults to `null`. MongoDB documents without this field function seamlessly with the updated codebase.
- **Optional Historical Backfill:** If legacy analytics require backfilling `pointsDeductedAt` on orders delivered prior to this deployment, run the provided script in `docs/DATABASE_CHANGE_REFERENCE.md`.

---

## 4. Pre-Deployment Checklist

1. **Verify Environment Variables:**
   - Confirm `PUBLIC_BASE_URL` points to the publicly accessible domain so `checkoutUrl` links generated in `startPayment()` are reachable by mobile clients.
   - If deploying to staging or test environments with mock payments, ensure `PAYMENT_GATEWAY=test` or omit Razorpay credentials.
2. **Review CSP Headers on Reverse Proxy:**
   - If NGINX or Cloudflare is used in front of the Node.js API, verify that the reverse proxy does not overwrite the custom `Content-Security-Policy` header set on `GET /api/v1/payments/checkout/:orderId`.
3. **Razorpay Dashboard Configuration:**
   - Ensure `https://<YOUR_API_DOMAIN>/api/v1/payments/webhook` is configured in the Razorpay Webhooks dashboard with events `order.paid`, `payment.authorized`, `payment.failed`.

---

## 5. Deployment Procedure

### Standard Zero-Downtime Deployment Steps
```bash
# 1. Fetch latest code
git fetch origin main
git checkout 306b28f866288d46b4b3c4e3b78e2b8462ac1f70

# 2. Verify dependencies (clean install)
npm ci --only=production

# 3. Run validation tests
npm test

# 4. Restart Node process / PM2 / Docker Container
# Example with PM2:
pm2 reload mealji-api --update-env

# Example with Docker Compose:
docker compose up -d --build api
```

---

## 6. Post-Deployment Verification

1. **Health Check:**
   ```bash
   curl -s http://127.0.0.1:4000/health | grep '"status":"ok"'
   ```
2. **Payment Gateway Assertion:**
   Check server startup logs to confirm the gateway was selected properly:
   ```
   [INFO] Server entrypoint - live razorpay & universal subscription serviceability enabled
   ```
3. **Verify Hosted Checkout Route:**
   ```bash
   curl -I http://127.0.0.1:4000/api/v1/payments/checkout/000000000000000000000000
   # Should return HTTP 404 (or 200 with HTML on valid orderId) with CSP headers
   ```

---

## 7. Rollback Plan

If an unexpected regression occurs in production:
1. **Trigger Code Rollback:**
   ```bash
   git checkout d127a33a59df76feff0f81d8985c4942ae3bfbca
   pm2 reload mealji-api
   ```
2. **Database Impact:**
   - No database rollback or field removal is required. Documents with `pointsDeductedAt` remain completely inert under commit `d127a33`.
3. **In-Flight Orders Handling:**
   - For orders created during the new deployment window where points were reserved (`pointsUsed > 0` but `pointsDeductedAt === null`), upon transition under the old code, points will not be deducted at delivery. A manual adjustment script can reconcile balances if necessary.
