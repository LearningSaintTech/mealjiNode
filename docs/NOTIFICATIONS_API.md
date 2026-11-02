# Notifications: personalisation, pictures, bulk, scheduled and segmented sends

Admin endpoints for sending free-text notifications. All are under `/api/v1/admin`, need a staff
token, and answer `{ success, message, data }`. Broadcasts reuse the campaign engine, so they
are throttled, resumable, approved like campaigns and appear in campaign stats.

## Personal variables

Any title or body may use `{{variable}}`, or `{{variable | fallback}}` to print the fallback when
the value is empty, for example `Hi {{user.firstName}}` or `Meals in {{user.city | your city}}`.

| Variable | Example |
|:---|:---|
| `user.firstName` | Priya ("there" when the name is unknown) |
| `user.name` | Priya Nair |
| `user.phoneLast4` | 3210 |
| `user.city` | Noida |
| `user.pointsBalance` | 120 |
| `user.referralCode` | PRIYA50 |
| `user.ordersCount` | 8 (delivered orders) |
| `user.daysSinceLastOrder` | 12 |
| `user.tier` | Gold |
| `user.planCode` | STANDARD_MONTHLY |
| `user.isPlusMember` | yes / no |
| `couponCode` | the broadcast's coupon code |

Saved templates can use the same variables. Profile variables (everything except `firstName` and
`name`) are loaded only when a message uses them. An unknown variable in a broadcast is refused
with 422.

`GET /notifications/variables` (permission `notifications.send`) returns this list, the fallback
syntax and the hosts pictures may come from.

## Pictures

`content.imageUrl` must be an `https` JPG, PNG, WebP or GIF on a MealJi host (the API host, the
CDN, the S3 bucket, or `LINK_HOSTS`). Upload one with `POST /api/v1/uploads/presign` and
`purpose: "notification"` (staff only, up to 1 MB, public link).

| Channel | How the picture shows |
|:---|:---|
| Push | Big picture on Android; on iOS through a notification service extension (`mutable-content: 1`, `fcm_options.image`) |
| In-app inbox | `imageUrl` on the inbox item |
| Email | Inline under the text |
| WhatsApp | `headerImageUrl` on a template whose approved header is an image |

A picture that fails these rules in a saved template is dropped and the message still goes.

## Content and audience shapes

```json
"content": { "title": "Hi {{user.firstName}}, lunch is ready", "body": "{{user.pointsBalance}} points waiting.", "imageUrl": "https://cdn.mealji.in/notification/lunch.jpg", "deepLink": "mealji://menu" }
```
- `title` is 2 to 80 characters and `body` is 2 to 500.
- `deepLink` is either `mealji://…` or an `https` MealJi page.

`audience` takes one of these forms:

| `type` | Fields | Who |
|:---|:---|:---|
| `all` | | every customer |
| `segment` | `segmentId` | a saved segment (dynamic or static) |
| `rules` | `rules` | segment rules, without saving a segment (same format as `/segments/preview`) |
| `users` | `userIds` | up to 200,000 user IDs |
| `phones` | `phones` (array) or `csv` (pasted text) | up to 200,000 ten-digit mobiles; `+91` and duplicates are handled, and unknown numbers are counted in `unmatched` |

`schedule` takes one of these forms:
- omitted or `{ "type": "now" }`
- `{ "type": "once", "sendAt": "<ISO time>" }`: at least a minute and at most 90 days ahead
- `{ "type": "recurring", "frequency": "daily" | "weekly", "time": "HH:mm" (IST), "weekday": 0-6 (weekly), "endAt": "<ISO>" (optional) }`

`category` takes one of two values:
- `marketing` (default): consent, quiet hours and frequency caps apply.
- `transactional`: a service notice such as "kitchen closed today", sent at any hour.

`channels` defaults to `["inapp", "push"]`. The full set is `inapp`, `push`, `whatsapp`, `sms` and `email`.

## Endpoints

| Endpoint | Permission | What it does |
|:---|:---|:---|
| `POST /notifications/audience-preview` `{ audience }` | `campaigns.manage` | `{ total, unmatched, reachable: { inapp, push, whatsapp, email }, sample[10] }` |
| `POST /notifications/broadcasts/test` `{ content, channels?, category? }` | `campaigns.manage` | Sends the message to you now, with your own variables |
| `POST /notifications/broadcasts` `{ name?, content, audience, schedule?, channels?, category?, throttlePerMinute? (10-5000, default 1000), couponCode?, respectQuietHours? }` | `campaigns.manage` | Creates and schedules it; `status` is `scheduled`, or `pending_approval` above the campaign approval size (approve with `POST /campaigns/:id/approve`) |
| `GET /notifications/broadcasts?status=&page=&limit=` | `campaigns.manage` | Broadcasts, newest first |
| `GET /notifications/broadcasts/:id` | `campaigns.manage` | The broadcast, `stats` (per channel: sent, opened, clicked, converted) and `progress` (`pending`, `sent`, `suppressed`, `failed` in the latest run) |
| `PATCH /notifications/broadcasts/:id/schedule` `{ schedule }` | `campaigns.manage` | New time or recurrence, before it has started (it goes through approval again if needed) |
| `POST /notifications/broadcasts/:id/cancel` | `campaigns.manage` | Stops it, including mid-send |
| `POST /notifications/send` `{ userIds[≤200], title, body, imageUrl?, deepLink?, channels?, category? }` | `notifications.send` | Immediate send to a few people; now also personalised and with a picture |

The broadcast's `broadcastId` is its campaign ID. Campaigns also accept `audience: "rules"` with
`rules`, `audience: "users"` with `userIds`, `category`, and `content` (a free-text message with no
template). `GET /campaigns?kind=broadcast|campaign` filters the list.
