# mealJiNode

The MealJi API: phone-OTP sign-in, role-based access, per-kitchen menus, cart and a single server-side bill, orders with online and cash payments, a provider-neutral delivery layer, MealJi Plus subscriptions with daily meal selection, loyalty and referrals, support, notifications across push / in-app / WhatsApp / SMS / email, marketing automation, analytics and reports. Every business value (fees, taxes, plans, slots, limits, quiet hours…) is set by the admin or the kitchen in the settings centre; nothing is hard-coded.

The architecture and phase plan are in `../MealJi_Backend_Architecture.md`. The staff console is `../mealJiAdmin`.

## Stack

Node.js 20+, Express 4, MongoDB (replica set for transactions), Redis (cache, rate limits, OTP, BullMQ queues, realtime fan-out), `ws` for WebSockets. Payments: Razorpay (a built-in test gateway is used when no keys are set). SMS OTP: 2Factor. Maps: Google. Push: FCM HTTP v1. WhatsApp: Meta Cloud API. Email and file storage: Amazon SES / S3 via signed requests (no SDK).

## Run

```bash
docker compose up -d
cp .env.example .env
npm install
npm run seed
npm run dev
```

`docker compose` starts MongoDB (replica set) on 27018 and Redis on 6381; see "Local infrastructure". `npm run seed` creates the roles, permissions, demo accounts and (outside production) demo data for every module:

| Phone | Account |
| --- | --- |
| 9000000001 | Super admin |
| 9000000002 | Platform subadmin |
| 9000000003 – 9000000007 | Ops manager, marketing manager, finance, support agent, analyst |
| 9000000011 / 9000000021 | Kitchen admins (Koramangala / Indiranagar) |
| 9000000012 / 9000000022 | Kitchen subadmins |
| 9000000031 – 9000000040 | Customers (Rahul Sharma, Priya Nair, …) |

Demo data (`scripts/seedDemo.js`): a 28-dish master library imported into both kitchen menus with combos; breakfast/lunch/dinner slots and weekly slot menus; four MealJi Plus plans (one draft); banners, onboarding slides and About the chef; six coupons; a GST billing entity; a manual delivery account; support categories, FAQs and canned replies; a rewards catalogue; segments, two draft campaigns and an experiment. Activity: about 55 orders spread over the last eight weeks (delivered, rated, cancelled and refunded) plus five live orders for today, three active subscriptions with meal picks, five support tickets, and the daily metrics rolled up so the dashboards have history.

- Re-running `npm run seed` only adds what is missing; activity is created once.
- `npm run seed -- --fresh` clears orders, payments, menus, plans, content and other test data (a JSON backup goes to `.seed-backups/`) and builds the demo data again. Settings, roles, kitchens and accounts are kept.
- `npm run seed -- --no-demo-data` seeds only roles and accounts.

Demo accounts are flagged `isDemo`: their notifications reach the in-app inbox only, never SMS, WhatsApp, email or push, because the 90000000xx numbers may belong to real people.

With `FIXED_OTP=123456` every OTP is that code (never in production). Without a fixed OTP or a 2Factor key the code is written to the server log.

Processes:
- `npm run dev` / `npm start` – the API, the WebSocket server on `/ws`, and (in development) the background workers.
- `npm run worker` – background workers on their own. In production run it separately with `RUN_WORKERS_IN_API=false` on the API.

## Configuration

`.env.example` lists every variable. Beyond the database, Redis, JWT and OTP settings:

| Area | Variables | Without them |
| --- | --- | --- |
| Public URL | `PUBLIC_BASE_URL` | `http://localhost:PORT` (links in emails, local upload URLs) |
| Files | `STORAGE_DRIVER` (`local` / `s3`), `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `CDN_BASE_URL` | Local folder `uploads/` served at `/files` (development only) |
| Payments | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Test gateway: same flows, `POST /api/v1/payments/test/complete` simulates checkout. Required in production |
| Push | `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Messages are logged, not sent (development) |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | Logged |
| SMS | `TWOFACTOR_API_KEY`, `SMS_SENDER_ID` | Logged |
| Email | `EMAIL_FROM`, `SES_REGION` (+ AWS keys), `EMAIL_WEBHOOK_TOKEN` | Logged |

## Clients

iOS and Android send `Authorization: Bearer <accessToken>` and a stable `x-device-id` (8–80 characters, created once per install). The access token lasts 1 hour; the refresh token 60 days per device (rotated, reuse revokes the device). Success responses are `{ success, message, data }`; failures `{ success: false, message, errors }`. All money is integer paise; dates are IST `YYYY-MM-DD`; times `HH:mm`.

Realtime: `wss://<host>/ws?token=<accessToken>`, envelope `{ type, data }`. A socket joins `user:{id}`; kitchen staff also join `kitchen:{id}`; staff with `orders.read` join `admin:ops`. Send `{ "type": "track:subscribe", "data": { "orderId" } }` to follow an order. Events: `order:status`, `track:status`, `order:kitchen_step`, `order:rider_assigned`, `track:location`, `kitchen:order_new`, `kitchen:order_updated`, `kitchen:sla_breach`, `kitchen:delivery_updated`, `notification:new`, `payment:status`, `subscription:updated`, `meal:status`. The socket closes with code 4401 when the token expires. Every realtime screen also has a REST endpoint for polling.

## Modules

The full list of 388 routes, with example bodies, is in the Postman collection (`postman/`). Areas:

| Phase | Module | Customer app | Kitchen console | Platform console |
| --- | --- | --- | --- | --- |
| 0 | Identity & access | `/auth/*` | team, custom kitchen roles | staff, roles (incl. custom roles), permissions, people |
| 0 | Settings centre | `GET /app/config` (+ experiments when signed in) | `/kitchen/settings/*` within platform limits | `/admin/settings/*`, kitchen limits `/admin/settings/:key/limits` |
| 1 | Profile, consent, addresses, geo | `/users/me*`, `/geo/*`, `/serviceability*` | – | `/admin/users/:id/addresses`, consents, traits |
| 1 | Catalog | `/menu*`, `/combos*`, `/dishes*` | `/kitchen/menu/*` (approval policy applies) | master library, any kitchen's menu, menu-change approvals |
| 1 | Content | `/home`, `/onboarding/slides`, `/kitchen-about` | About page | banners, slides, home layout |
| 1 | Cart & pricing | `/cart*`, `/promos/available`, `/checkout/summary`, `/delivery/slots` | – | pricing / tax settings |
| 1 | Orders | `/orders*` (place, live, tracking, cancel, rate, reorder, receipt) | `/kitchen/orders*` live desk, steps, delivery, rider location | `/admin/orders*`, cancel with refund |
| 1 | Payments & invoicing | `/payments/verify`, `/invoices*` | billing entity | payments, refunds with approval limit, invoices, billing entities |
| 1 | Delivery | tracking | book / rebook / assign rider / picked up / delivered | deliveries, partner accounts |
| 1 | Notifications | `/notifications*`, `/devices` | – | templates, one-off sends, message log |
| 1 | Analytics & reports | `POST /analytics/events` | `/kitchen/reports/*` | dashboards `/admin/analytics/*`, `/admin/reports/*` (export, schedules) |
| 2 | MealJi Plus | `/subscription-plans*`, `/subscriptions/*` (checkout, days, menu, selection, shift, pause, cancel/undo, change plan, invoices) | slots, slot menus, production sheet (PDF), dispatch | plan builder, subscriptions, actions on behalf |
| 3 | Loyalty & offers | `/rewards/*`, `/referrals/*`, `/payment-methods*`, `/wallet` | kitchen-funded offers | rewards catalogue, liability, point adjustments, referrals, coupons |
| 3 | Discovery & support | `/search*`, `/users/me/favorites`, `/support/*` | – | ticket queue, FAQs, categories, canned replies, search insights and synonyms |
| 4 | Engagement | `/in-app-messages` | – | segments (rules + CSV), campaigns (approval, A/B, holdout, schedule), journeys, in-app messages |
| 5 | Optimisation | experiment variants in `/app/config` | live rider location | experiments with results, send-time optimisation, partner auto-selection, personal home picks |

Seeded roles: `superadmin`, `subadmin`, `ops_manager`, `marketing_manager`, `finance`, `support_agent`, `analyst` (platform); `kitchen_admin`, `kitchen_subadmin` (kitchen); `user`. Custom roles are created in the console (`staff_…` / `kitchen_…` slugs). Authorization reads permissions from the role on every request.

## How things fit together

- **Settings centre.** Groups in `src/modules/settings/settings.definitions.js` (`app`, `order_policy`, `pricing`, `tax`, `delivery`, `menu_policy`, `subscription_policy`, `loyalty`, `notification_policy`, `support`). Versioned patches, optional future `effectiveFrom`, scopes global → city → kitchen, a reason for money changes, audit + event in one transaction. Business code reads `resolveSetting(key, { kitchenId })`. The platform sets per field whether kitchens may override and within what range.
- **One bill.** `src/modules/pricing/pricing.engine.js` is a pure function used by the cart, checkout summary and order placement: delivery fee (flat, distance slabs or partner quote with markup), free-delivery threshold, packaging, small-order and platform fees, peak-hour fee, tips, coupons, points, GST per charge type (CGST+SGST or IGST by place of supply, tax-inclusive menus supported).
- **Orders.** State machine in `order.states.js`; placement re-prices, checks the kitchen is open and accepting, the address is in range and stock is available, then reserves stock, coupon and points in one transaction. Unpaid orders expire; unaccepted orders raise SLA alerts and can auto-cancel with a refund. Invoices are numbered per billing entity per financial year.
- **Subscriptions.** Plans are admin data; subscribers keep a snapshot. Billing by autopay (mandate) or a payment link each cycle, with fallback to a link when autopay fails, reminders, pre-debit notices, grace period and past-due handling. Meal slots and their times are set per kitchen; at each cutoff chosen meals lock and empty ones follow the plan's policy (default auto-shift: moved after the end date).
- **Events.** `publishEvent` writes to the outbox (in the business transaction); handlers in `src/events/handlers.js` and `*/…handlers.js` run at least once and are idempotent. They drive notifications, delivery booking, points, referral payouts, analytics server events, customer traits, journeys and campaign attribution.
- **Jobs.** `src/jobs/tasks.js` (BullMQ, cron in IST): settings activation, order and delivery watchdogs, meal cutoffs, subscription billing and daily lifecycle, loyalty (birthdays, expiry), support SLA, campaign dispatcher, journey runner, nightly traits, hourly metric rollups, warehouse export, report schedules, payment reconciliation, account purge (30 days after deletion).
- **Reports.** Code-registered definitions (`registerReport`) with paging, CSV export jobs, email schedules and kitchen scoping; 40+ reports across sales, operations, finance (GST, invoices, settlements, liability), subscriptions, customers, marketing and support.

### Local infrastructure
`docker compose up -d` starts MongoDB as a single-node replica set on 27018 and Redis on 6381:

```
MONGO_URI=mongodb://127.0.0.1:27018/mealji?replicaSet=rs0&directConnection=true
REDIS_PORT=6381
```

On a standalone MongoDB the API still runs in development, but transactions are skipped (a warning is logged). Production refuses to start without a replica set.

## Tests

`npm test` runs the unit tests in `test/` (money, time, settings, pricing engine, coupons, kitchen hours, order states, subscription rules).

## Keep Postman in sync

`npm run postman:sync` adds every new route to `postman/mealJiNode.postman_collection.json` (grouped by area, with example bodies for the main flows). `npm run postman:check` fails while a mounted route is missing from the collection or a request points at a route that no longer exists.

## Adding a permission

1. Add the key to `src/constants/permissions.js` and grant it in `ROLE_GRANTS`.
2. Run `npm run seed` – new keys reach their default roles even if a role was customised.
3. Guard the route with `authorize("your.permission")`.
4. `npm run postman:sync && npm run postman:check`.
