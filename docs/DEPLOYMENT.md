# MealJi deployment (AWS, ap-south-1)

Everything MealJi owns is named `mealji-*` and tagged `project=mealji`. The AWS
account also runs other company apps: never change resources that are not MealJi's.

| Address | What | AWS |
|---|---|---|
| https://api.mealji.in | Backend API (this repo) | EC2 `mealji-api` (t3.small, Ubuntu 24.04), Elastic IP 65.2.217.123 |
| https://admin.mealji.in | Admin / kitchen console | S3 `mealji-admin-console` + CloudFront `EA7O02KODKWZB` |
| https://media.mealji.in | Images and uploads | S3 `mealji-media` + CloudFront `E14SIDAJU5JBC3` |
| https://mealji.in (www redirects to it) | Website (`mealjiWeb` repo) | S3 `mealji-website` + CloudFront `E29XA76HBA7BPP` |

- DNS: Route 53 zone `mealji.in` (domain registered at GoDaddy, nameservers point to Route 53).
- Certificates: ACM `mealji.in` + `*.mealji.in` (us-east-1) for CloudFront; Let's Encrypt (certbot, auto-renew) for `api.mealji.in`.
- Database: MongoDB Atlas, database `mealji-prod` (shared cluster — the seed refuses any database not named `mealji*`).
- The server's S3 key belongs to IAM user `mealji-api`, limited to the `mealji-media` bucket.

## Server layout

- Code: `/opt/mealji/api` (settings in `/opt/mealji/api/.env`, owner-only).
- Processes: PM2 apps `mealji-api` (HTTP + WebSocket) and `mealji-worker` (queues and scheduled jobs),
  from `/opt/mealji/mealji.production.config.cjs`; start on boot; logs in `/opt/mealji/logs` (rotated).
  PM2 only treats a file as a config when its name ends in `.config.cjs` — otherwise it runs it as a script.
- Nginx: `/etc/nginx/sites-available/mealji-api` → `127.0.0.1:4000` (WebSocket `/ws` passes through).
- Redis: local, `127.0.0.1:6379` (queues, locks, rate limits).
- SSH: `ssh -i ~/.ssh/mealji-api.pem ubuntu@65.2.217.123` (port 22 open only to the admin IP in security group `mealji-api-sg`).

## Mode

The server runs in **production mode** (since 2026-10-22): `NODE_ENV=production`, no fixed OTP
(logins get a real SMS OTP via 2Factor), Razorpay live keys, test payment helpers switched off.
Background workers run only in `mealji-worker` (`RUN_WORKERS_IN_API` is off in production).
The API refuses to start if a production setting is missing (`assertRuntimeEnv`).

Razorpay Dashboard webhook: URL `https://api.mealji.in/api/v1/webhooks/razorpay`, secret =
`RAZORPAY_WEBHOOK_SECRET` in `.env`, events `payment.captured`, `payment.failed`, `order.paid`,
`refund.processed`, `refund.failed`, `payment_link.paid`, `subscription.activated`,
`subscription.charged`, `subscription.halted`, `subscription.cancelled`.

## Delivery platform (MealJi as a tenant)

Riders come from our own delivery platform (the `shipping` project). MealJi is one company
(tenant) on it. Once per environment, on the platform's production server:

1. Create the company (ops admin key) and keep the API key it returns (shown once):
   `curl -X POST https://<platform host>/admin/companies -H "x-admin-key: <ADMIN_API_KEY>" -H "content-type: application/json" -d '{"name":"MealJi"}'`
2. Register MealJi's webhook with that key and keep the secret it returns (shown once):
   `curl -X POST https://<platform host>/v1/webhooks -H "Authorization: Bearer <sk_live_...>" -H "content-type: application/json" -d '{"url":"https://api.mealji.in/api/v1/webhooks/delivery/shipping"}'`
   (Both steps can also be done in the platform's company portal at `/portal`.)
3. In `/opt/mealji/api/.env`: `SHIPPING_API_URL=https://<platform host>`, `SHIPPING_API_KEY`,
   `SHIPPING_WEBHOOK_SECRET`; then `pm2 reload mealji-api mealji-worker`. The worker logs
   "Delivery platform stream connected" (live rider positions; one worker holds the stream).
4. In the admin console, Settings → Delivery: set "Delivery partner" to **MealJi delivery platform**
   (globally, per city or per kitchen), keep "Book a rider automatically" on, and choose when riders are
   booked for orders and how many minutes before dispatch for subscription meals. "Best available
   partner" also compares the platform's quote with other partners.

Rotate the webhook secret on the platform (`POST /v1/webhooks/:id/rotate-secret`) and update `.env`
within 24 hours (the old secret keeps signing until then). Revoke a leaked API key from the portal.

The database still holds demo data (demo staff and customer numbers are not real phones).
Before opening to customers, reseed without demo data (`node scripts/seed.js --no-demo-data`)
or clean the demo records, and make sure a real mobile number has the super-admin role.

## Deploy a new backend version

From this repo (Git Bash), after committing:

```bash
git archive --format=tar.gz -o /tmp/mealji-api.tar.gz HEAD
scp -i ~/.ssh/mealji-api.pem /tmp/mealji-api.tar.gz ubuntu@65.2.217.123:/tmp/
ssh -i ~/.ssh/mealji-api.pem ubuntu@65.2.217.123 'cd /opt/mealji/api && tar -xzf /tmp/mealji-api.tar.gz && npm ci --omit=dev --no-audit --no-fund && pm2 reload mealji-api mealji-worker && pm2 save'
curl -s https://api.mealji.in/health
```

`.env` is not in git and is never overwritten by a deploy.

## Deploy the admin console

From `mealJiAdmin`:

```bash
VITE_API_URL=https://api.mealji.in npm run build
aws s3 sync dist/ s3://mealji-admin-console/ --delete --exclude index.html --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/index.html s3://mealji-admin-console/index.html --cache-control "no-cache,no-store,must-revalidate" --content-type "text/html; charset=utf-8"
```

## Useful commands on the server

```bash
pm2 ls                      # status
pm2 logs mealji-api         # live API logs
pm2 logs mealji-worker      # live job/queue logs
pm2 reload mealji-api mealji-worker   # restart after a deploy or .env change
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```
