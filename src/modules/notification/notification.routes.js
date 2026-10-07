import crypto from "node:crypto";
import express, { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { env } from "../../config/env.js";
import { recordAudit } from "../audit/audit.service.js";
import { recordConsent } from "../consent/consent.model.js";
import { User } from "../user/user.model.js";
import { channelStatus } from "./channels.js";
import { CHANNELS, INBOX_CATEGORIES, MessageLog } from "./notification.model.js";
import * as notifications from "./notification.service.js";

// ------------------------------------------------------------------ app
export const customerNotificationRouter = Router();
customerNotificationRouter.use(authFor(["/notifications", "/devices"], authMiddleware));
customerNotificationRouter.get("/notifications", pageQuery, query("category").optional().isIn(INBOX_CATEGORIES), query("unread").optional().isBoolean().toBoolean(), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await notifications.listInbox(req.auth.userId, { ...req.query, page, limit }), "Notifications fetched.");
}));
customerNotificationRouter.get("/notifications/unread-count", asyncHandler(async (req, res) => ok(res, { unreadCount: await notifications.unreadCount(req.auth.userId) }, "Unread count.")));
customerNotificationRouter.patch("/notifications/read-all", asyncHandler(async (req, res) => ok(res, await notifications.markAllRead(req.auth.userId), "All read.")));
customerNotificationRouter.patch("/notifications/:id/read", idParam(), validate, asyncHandler(async (req, res) => ok(res, await notifications.markRead(req.auth.userId, req.params.id), "Marked read.")));
// The app reports opens/clicks for push and in-app messages (deep links carry ?mid=).
customerNotificationRouter.post("/notifications/track", body("messageId").isString().isLength({ max: 60 }), body("event").isIn(["opened", "clicked"]), body("channel").optional().isIn(CHANNELS), validate, asyncHandler(async (req, res) => {
  const owned = await MessageLog.exists({ messageId: req.body.messageId, user: req.auth.userId });
  if (!owned) throw new AppError(404, "Message not found");
  return ok(res, await notifications.trackMessage(req.body.messageId, req.body.event, { channel: req.body.channel || null }), "Tracked.");
}));
customerNotificationRouter.post(
  "/devices",
  body("deviceId").isString().trim().isLength({ min: 4, max: 120 }),
  body("fcmToken").optional({ values: "null" }).isString().isLength({ max: 4096 }),
  body("platform").isIn(["android", "ios", "web"]),
  body("appVersion").optional().isString().isLength({ max: 20 }),
  body("osVersion").optional().isString().isLength({ max: 40 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await notifications.registerDevice(req.auth.userId, req.body), "Device registered.")),
);
customerNotificationRouter.delete("/devices/:deviceId", param("deviceId").isString().isLength({ max: 120 }), validate, asyncHandler(async (req, res) => ok(res, await notifications.removeDevice(req.auth.userId, req.params.deviceId), "Device removed.")));

// ------------------------------------------------------------------ admin
export const adminNotificationRouter = Router();
adminNotificationRouter.use(authFor(["/notification-templates", "/notifications", "/messages"], authMiddleware));
adminNotificationRouter.get("/notification-templates", authorize("templates.manage"), asyncHandler(async (req, res) => ok(res, { templates: await notifications.listTemplates(), channels: channelStatus() }, "Templates fetched.")));
adminNotificationRouter.get("/notification-templates/:key", authorize("templates.manage"), param("key").matches(/^[a-z0-9_.]{3,60}$/), validate, asyncHandler(async (req, res) => {
  const template = await notifications.getTemplate(req.params.key);
  if (!template) throw new AppError(404, "Template not found");
  return ok(res, template, "Template fetched.");
}));
adminNotificationRouter.put("/notification-templates/:key", authorize("templates.manage"), param("key").matches(/^[a-z0-9_.]{3,60}$/), body("channels").optional().isObject(), body("category").optional().isIn(["transactional", "marketing"]), body("inboxCategory").optional().isIn(INBOX_CATEGORIES), validate, asyncHandler(async (req, res) => {
  const data = await notifications.saveTemplate(req.params.key, req.body, { userId: req.auth.userId, name: req.auth.user?.name });
  await recordAudit(req, { action: "template.saved", entityType: "template", entityId: req.params.key, summary: `Saved template ${req.params.key} v${data.version}`, diff: false });
  return ok(res, data, "Template saved.");
}));
adminNotificationRouter.post("/notification-templates/:key/preview", authorize("templates.manage"), param("key").matches(/^[a-z0-9_.]{3,60}$/), validate, asyncHandler(async (req, res) => {
  const template = req.body.channels ? { channels: req.body.channels } : await notifications.getTemplate(req.params.key);
  if (!template) throw new AppError(404, "Template not found");
  const data = { user: { name: "Priya Nair", firstName: "Priya" }, ...(req.body.data || {}) };
  const rendered = Object.fromEntries(Object.entries(template.channels || {}).filter(([, value]) => value).map(([channel, content]) => [channel, Object.fromEntries(Object.entries(content).map(([key, value]) => [key, typeof value === "string" ? notifications.render(value, data) : value]))]));
  return ok(res, rendered, "Preview.");
}));
adminNotificationRouter.post("/notification-templates/:key/test-send", authorize("templates.manage"), param("key").matches(/^[a-z0-9_.]{3,60}$/), body("channels").optional().isArray(), validate, asyncHandler(async (req, res) => (
  ok(res, await notifications.notify({ userId: req.auth.userId, templateKey: req.params.key, data: req.body.data || {}, channels: req.body.channels || null, category: "transactional", ignoreCaps: true, respectQuietHours: false }), "Test sent to you.")
)));
adminNotificationRouter.post(
  "/notifications/send",
  authorize("notifications.send"),
  body("userIds").isArray({ min: 1, max: 200 }),
  body("userIds.*").isMongoId(),
  body("title").isString().trim().isLength({ min: 2, max: 80 }),
  body("body").isString().trim().isLength({ min: 2, max: 300 }),
  body("channels").optional().isArray(),
  body("category").optional().isIn(["transactional", "marketing"]),
  validate,
  asyncHandler(async (req, res) => {
    const results = [];
    // Marketing sends respect consent, quiet hours and caps; transactional (service) messages do not.
    for (const userId of req.body.userIds) {
      results.push({ userId, ...(await notifications.notify({ userId, templateKey: "ops.message", data: { title: req.body.title, body: req.body.body }, channels: req.body.channels || ["inapp", "push"], category: req.body.category || "transactional" })) });
    }
    await recordAudit(req, { action: "notification.sent", entityType: "notification", summary: `Sent "${req.body.title}" to ${req.body.userIds.length} person(s)`, diff: false, after: { userIds: req.body.userIds } });
    return ok(res, { sent: results.length, results }, "Sent.");
  }),
);
adminNotificationRouter.get("/messages", authorize("messages.read"), pageQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await notifications.searchMessages({ ...req.query, page, limit }), "Messages fetched.");
}));

// ------------------------------------------------------------------ public links & provider webhooks
export const publicNotificationRouter = Router();

// One-click unsubscribe (email footer and List-Unsubscribe).
async function unsubscribe(req, res) {
  const data = notifications.readUnsubscribeToken(req.params.token);
  if (!data) throw new AppError(404, "This link is not valid");
  await User.updateOne({ _id: data.u }, { $set: { [`preferences.channels.${data.c}`]: false } });
  await recordConsent({ userId: data.u, channel: data.c, purpose: "marketing", granted: false, source: "unsubscribe_link", ip: req.ip });
  if (req.method === "POST") return ok(res, { unsubscribed: true }, "Unsubscribed.");
  return res.type("html").send("<!doctype html><meta name=viewport content='width=device-width'><title>Unsubscribed</title><p style='font-family:sans-serif;padding:24px'>You will no longer get MealJi offers by this channel. Order updates still reach you.</p>");
}
publicNotificationRouter.get("/u/:token", asyncHandler(unsubscribe));
publicNotificationRouter.post("/u/:token", asyncHandler(unsubscribe));

// Click redirect for email links: /r/<messageId>?to=<url>
publicNotificationRouter.get("/r/:messageId", asyncHandler(async (req, res) => {
  const target = String(req.query.to || "");
  const allowed = /^https:\/\//.test(target) || target.startsWith("mealji://");
  await notifications.trackMessage(req.params.messageId, "clicked").catch(() => {});
  return res.redirect(302, allowed ? target : env.publicBaseUrl);
}));

export const notificationWebhookRouter = Router();
// WhatsApp Cloud API: verification handshake, delivery receipts and STOP opt-outs.
notificationWebhookRouter.get("/whatsapp", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && env.whatsappVerifyToken && req.query["hub.verify_token"] === env.whatsappVerifyToken) return res.send(req.query["hub.challenge"]);
  return res.sendStatus(403);
});
notificationWebhookRouter.post("/whatsapp", express.raw({ type: "*/*", limit: "1mb" }), asyncHandler(async (req, res) => {
  if (env.whatsappAppSecret) {
    const expected = `sha256=${crypto.createHmac("sha256", env.whatsappAppSecret).update(req.body).digest("hex")}`;
    if (expected !== req.headers["x-hub-signature-256"]) throw new AppError(401, "Invalid signature");
  } else if (env.isProd) {
    throw new AppError(401, "Not configured");
  }
  const payload = JSON.parse(req.body.toString("utf8") || "{}");
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const status of change.value?.statuses || []) {
        const event = { delivered: "delivered", read: "opened" }[status.status];
        const log = await MessageLog.findOne({ providerMessageId: status.id }).lean();
        if (log && event) await notifications.trackMessage(log.messageId, event, { channel: "whatsapp" });
        if (log && status.status === "failed") await MessageLog.updateOne({ _id: log._id }, { $set: { status: "failed", error: status.errors?.[0]?.title || "failed" } });
      }
      for (const message of change.value?.messages || []) {
        const text = String(message.text?.body || message.button?.text || "").trim().toUpperCase();
        const phone = String(message.from || "").slice(-10);
        const user = await User.findOne({ phoneNumber: phone }).select("_id").lean();
        if (!user) continue;
        if (["STOP", "UNSUBSCRIBE"].includes(text)) {
          await User.updateOne({ _id: user._id }, { $set: { "preferences.channels.whatsapp": false } });
          await recordConsent({ userId: user._id, channel: "whatsapp", purpose: "marketing", granted: false, source: "whatsapp_keyword" });
        } else if (["START", "SUBSCRIBE"].includes(text)) {
          await User.updateOne({ _id: user._id }, { $set: { "preferences.channels.whatsapp": true } });
          await recordConsent({ userId: user._id, channel: "whatsapp", purpose: "marketing", granted: true, source: "whatsapp_keyword" });
        }
      }
    }
  }
  return res.sendStatus(200);
}));
// Email bounces and complaints (SES via SNS or any relay posting {type, email}).
notificationWebhookRouter.post("/email", express.json({ type: "*/*" }), asyncHandler(async (req, res) => {
  if (env.emailWebhookToken && req.query.token !== env.emailWebhookToken) throw new AppError(401, "Invalid token");
  const message = typeof req.body.Message === "string" ? JSON.parse(req.body.Message) : req.body;
  const type = message.notificationType || message.eventType || message.type;
  const recipients = message.bounce?.bouncedRecipients?.map((item) => item.emailAddress) || message.complaint?.complainedRecipients?.map((item) => item.emailAddress) || (message.email ? [message.email] : []);
  if (["Bounce", "Complaint", "bounce", "complaint"].includes(type)) {
    for (const email of recipients) await notifications.suppress("email", email, String(type).toLowerCase());
  }
  return ok(res, { received: true }, "Received.");
}));
