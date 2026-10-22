# MealJi deployment (AWS, ap-south-1)

Everything MealJi owns is named `mealji-*` and tagged `project=mealji`. The AWS
account also runs other company apps: never change resources that are not MealJi's.

| Address | What | AWS |
|---|---|---|
| https://api.mealji.in | Backend API (this repo) | EC2 `mealji-api` (t3.small, Ubuntu 24.04), Elastic IP 65.2.217.123 |
| https://admin.mealji.in | Admin / kitchen console | S3 `mealji-admin-console` + CloudFront `EA7O02KODKWZB` |
| https://media.mealji.in | Images and uploads | S3 `mealji-media` + CloudFront `E14SIDAJU5JBC3` |

- DNS: Route 53 zone `mealji.in` (domain registered at GoDaddy, nameservers point to Route 53).
- Certificates: ACM `mealji.in` + `*.mealji.in` (us-east-1) for CloudFront; Let's Encrypt (certbot, auto-renew) for `api.mealji.in`.
- Database: MongoDB Atlas, database `mealji-prod` (shared cluster — the seed refuses any database not named `mealji*`).
- The server's S3 key belongs to IAM user `mealji-api`, limited to the `mealji-media` bucket.

## Server layout

- Code: `/opt/mealji/api` (settings in `/opt/mealji/api/.env`, owner-only).
- Process: PM2 app `mealji-api` (`/opt/mealji/ecosystem.config.cjs`), starts on boot; logs in `/opt/mealji/logs` (rotated).
- Nginx: `/etc/nginx/sites-available/mealji-api` → `127.0.0.1:4000` (WebSocket `/ws` passes through).
- Redis: local, `127.0.0.1:6379` (queues, locks, rate limits).
- SSH: `ssh -i ~/.ssh/mealji-api.pem ubuntu@65.2.217.123` (port 22 open only to the admin IP in security group `mealji-api-sg`).

## Mode

The server runs in **test mode** (`NODE_ENV=staging`): demo logins with the fixed OTP,
the test payment gateway and test helpers. For launch: set `NODE_ENV=production`, empty
`FIXED_OTP`, real `TWOFACTOR_API_KEY`, Razorpay live `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` /
`RAZORPAY_WEBHOOK_SECRET` (webhook URL `https://api.mealji.in/api/v1/webhooks/razorpay`), then
reseed without demo data (`node scripts/seed.js --no-demo-data`) or clean the demo records.

## Deploy a new backend version

From this repo (Git Bash), after committing:

```bash
git archive --format=tar.gz -o /tmp/mealji-api.tar.gz HEAD
scp -i ~/.ssh/mealji-api.pem /tmp/mealji-api.tar.gz ubuntu@65.2.217.123:/tmp/
ssh -i ~/.ssh/mealji-api.pem ubuntu@65.2.217.123 'cd /opt/mealji/api && tar -xzf /tmp/mealji-api.tar.gz && npm ci --omit=dev --no-audit --no-fund && pm2 reload mealji-api && pm2 save'
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
pm2 logs mealji-api         # live logs
pm2 reload mealji-api       # restart without downtime
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
```
