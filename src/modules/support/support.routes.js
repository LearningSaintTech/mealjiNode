import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, idParam, ok, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Faq } from "./support.model.js";
import * as support from "./support.service.js";
import "./reports.support.js";

const customer = Router();
customer.use(authFor(["/support"], authMiddleware));
customer.get("/support/config", asyncHandler(async (req, res) => {
  const definition = (await import("../settings/settings.definitions.js")).getDefinition("support");
  const { values } = await resolveSetting("support");
  const publicValues = Object.fromEntries(definition.fields.filter((field) => field.public).map((field) => [field.key, values[field.key]]));
  return ok(res, { ...publicValues, context: req.query.context || "default" }, "Support config.");
}));
customer.get("/support/categories", query("context").optional().isIn(["default", "subscription"]), validate, asyncHandler(async (req, res) => ok(res, await support.listCategories({ context: req.query.context || "default" }), "Categories.")));
customer.get("/support/faqs", query("context").optional().isIn(["default", "subscription"]), query("q").optional().isString().isLength({ max: 60 }), validate, asyncHandler(async (req, res) => ok(res, await support.listFaqs({ context: req.query.context || "default", q: req.query.q }), "FAQs.")));
customer.post("/support/faqs/:id/view", idParam(), validate, asyncHandler(async (req, res) => {
  await Faq.updateOne({ _id: req.params.id }, { $inc: { views: 1 } });
  return ok(res, { tracked: true }, "Tracked.");
}));
customer.post(
  "/support/tickets",
  body("category").isString().isLength({ min: 2, max: 40 }),
  body("issueType").optional({ values: "null" }).isString().isLength({ max: 60 }),
  body("orderId").optional({ values: "null" }).isMongoId(),
  body("subscriptionId").optional({ values: "null" }).isMongoId(),
  body("subject").optional({ values: "null" }).isString().isLength({ max: 120 }),
  body("description").isString().trim().isLength({ min: 5, max: 2000 }).withMessage("Describe the issue (at least 5 characters)"),
  body("attachments").optional().isArray({ max: 5 }),
  validate,
  asyncHandler(async (req, res) => ok(res, await support.createTicket(req.auth.userId, req.body), "Ticket created. We'll get back to you soon.", 201)),
);
customer.get("/support/tickets", pageQuery, validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await support.myTickets(req.auth.userId, { page, limit }), "Tickets.");
}));
customer.get("/support/tickets/:id", idParam(), validate, asyncHandler(async (req, res) => ok(res, await support.ticketDetail(req.params.id, { userId: req.auth.userId }), "Ticket.")));
customer.post("/support/tickets/:id/messages", idParam(), body("body").isString().trim().isLength({ min: 1, max: 4000 }), body("attachments").optional().isArray({ max: 5 }), validate, asyncHandler(async (req, res) => (
  ok(res, await support.addMessage(req.params.id, req.body, { userId: req.auth.userId, name: req.auth.user?.name, role: "customer" }), "Message sent.", 201)
)));
customer.post("/support/tickets/:id/csat", idParam(), body("rating").isInt({ min: 1, max: 5 }).toInt(), body("comment").optional().isString().isLength({ max: 500 }), validate, asyncHandler(async (req, res) => ok(res, await support.rateTicket(req.auth.userId, req.params.id, req.body), "Thanks for the feedback.")));
// Chat: WhatsApp click-to-chat (or a third-party widget) until own chat exists.
customer.post("/support/chat/sessions", asyncHandler(async (req, res) => {
  const { values } = await resolveSetting("support");
  if (!values.chatEnabled) return ok(res, { available: false, message: "Chat is not available right now. Raise a ticket or call us." }, "Chat unavailable.");
  const text = encodeURIComponent(`Hi MealJi, I need help. My account phone is ${req.auth.user?.phoneNumber || ""}.`);
  return ok(res, { available: true, provider: "whatsapp", url: values.whatsapp ? `https://wa.me/91${String(values.whatsapp).replace(/\D/g, "").slice(-10)}?text=${text}` : null, etaMinutes: values.chatEtaMinutes }, "Chat session.");
}));

const admin = Router();
admin.use(authFor(["/support"], authMiddleware));
const agent = authorize("tickets.handle");
const manager = authorize("support.manage");
admin.get("/support/tickets", agent, pageQuery, query("status").optional().isString(), query("breached").optional().isBoolean().toBoolean(), query("mine").optional().isBoolean().toBoolean(), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await support.queue({ ...req.query, page, limit }, req.auth.userId), "Ticket queue.");
}));
admin.get("/support/tickets/:id", agent, idParam(), validate, asyncHandler(async (req, res) => ok(res, await support.ticketDetail(req.params.id, { agent: true }), "Ticket.")));
admin.post("/support/tickets/:id/messages", agent, idParam(), body("body").isString().trim().isLength({ min: 1, max: 4000 }), body("internal").optional().isBoolean(), validate, asyncHandler(async (req, res) => (
  ok(res, await support.addMessage(req.params.id, req.body, { userId: req.auth.userId, name: req.auth.user?.name, role: "agent" }), "Reply sent.", 201)
)));
admin.patch(
  "/support/tickets/:id",
  agent,
  idParam(),
  body("status").optional().isIn(["open", "in_progress", "pending_customer", "resolved", "closed"]),
  body("priority").optional().isIn(["low", "normal", "high", "urgent"]),
  body("assigneeId").optional({ values: "null" }).isMongoId(),
  validate,
  asyncHandler(async (req, res) => {
    const data = await support.setStatus(req.params.id, { ...req.body, assigneeName: req.body.assigneeName || (req.body.assigneeId === req.auth.userId ? req.auth.user?.name : null) });
    await recordAudit(req, { action: "ticket.updated", entityType: "ticket", entityId: req.params.id, summary: `Ticket ${data.ticket.number} updated`, before: data.before, after: data.after });
    return ok(res, data.ticket, "Ticket updated.");
  }),
);
admin.get("/support/faqs", manager, asyncHandler(async (req, res) => ok(res, await support.listFaqs({ admin: true }), "FAQs.")));
admin.post("/support/faqs", manager, asyncHandler(async (req, res) => ok(res, await support.saveFaq(null, req.body), "FAQ added.", 201)));
admin.patch("/support/faqs/:id", manager, idParam(), validate, asyncHandler(async (req, res) => ok(res, await support.saveFaq(req.params.id, req.body), "FAQ updated.")));
admin.delete("/support/faqs/:id", manager, idParam(), validate, asyncHandler(async (req, res) => {
  await Faq.deleteOne({ _id: req.params.id });
  return ok(res, { deleted: true }, "FAQ deleted.");
}));
admin.get("/support/categories", (req, res, next) => (req.auth.permissions.includes("tickets.handle") || req.auth.permissions.includes("support.manage") ? next() : agent(req, res, next)), asyncHandler(async (req, res) => ok(res, await support.listCategories({ all: true }), "Categories.")));
admin.put("/support/categories/:key", manager, param("key").matches(/^[a-z_]{2,30}$/), body("name").isString().isLength({ min: 2, max: 60 }), validate, asyncHandler(async (req, res) => ok(res, await support.saveCategory(req.params.key, req.body), "Category saved.")));
admin.get("/support/canned-replies", agent, asyncHandler(async (req, res) => ok(res, await support.listCanned(), "Canned replies.")));
admin.post("/support/canned-replies", manager, asyncHandler(async (req, res) => ok(res, await support.saveCanned(null, req.body), "Saved.", 201)));
admin.patch("/support/canned-replies/:id", manager, idParam(), validate, asyncHandler(async (req, res) => ok(res, await support.saveCanned(req.params.id, req.body), "Saved.")));
admin.delete("/support/canned-replies/:id", manager, idParam(), validate, asyncHandler(async (req, res) => ok(res, await support.deleteCanned(req.params.id), "Deleted.")));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, customer);
  app.use("/api/v1/admin", recordMountPath, admin);
}
