import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok, pageQuery, paging } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { currentConsents } from "../consent/consent.model.js";
import { NotificationTemplate } from "../notification/notification.model.js";
import * as campaigns from "./campaign.service.js";
import * as inapp from "./inapp.service.js";
import * as journeys from "./journey.service.js";
import * as segments from "./segment.service.js";
import { computeTraits, UserStats } from "./traits.service.js";
import "./reports.engagement.js";

const actorOf = (req) => ({ userId: req.auth.userId, name: req.auth.user?.name || null, role: req.auth.role });

// ------------------------------------------------------------------ app
const customer = Router();
customer.use(authFor(["/in-app-messages"], authMiddleware));
customer.get("/in-app-messages", query("screen").isString().isLength({ min: 2, max: 40 }), validate, asyncHandler(async (req, res) => ok(res, await inapp.forScreen(req.auth.userId, req.query.screen), "In-app messages.")));
customer.post("/in-app-messages/:id/:event", idParam(), param("event").isIn(["shown", "clicked", "dismissed"]), validate, asyncHandler(async (req, res) => ok(res, await inapp.track(req.auth.userId, req.params.id, req.params.event), "Tracked.")));

// ------------------------------------------------------------------ admin
const admin = Router();
admin.use(authFor(["/segments", "/campaigns", "/journeys", "/in-app-messages", "/users", "/traits", "/notification-templates"], authMiddleware));

admin.get("/traits", authorize("segments.manage"), asyncHandler(async (req, res) => ok(res, segments.traitCatalog(), "Traits.")));
admin.get("/segments", authorize("segments.manage"), asyncHandler(async (req, res) => ok(res, await segments.listSegments(), "Segments.")));
admin.post("/segments/preview", authorize("segments.manage"), body("rules").optional().isObject(), body("segmentId").optional().isMongoId(), validate, asyncHandler(async (req, res) => ok(res, await segments.preview(req.body), "Preview.")));
admin.post("/segments", authorize("segments.manage"), body("name").isString().trim().isLength({ min: 2, max: 80 }), validate, asyncHandler(async (req, res) => {
  const data = await segments.saveSegment(null, req.body, actorOf(req));
  await recordAudit(req, { action: "segment.created", entityType: "segment", entityId: data.segmentId, summary: `Created segment ${data.name} (${data.estimatedSize} people)`, diff: false });
  return ok(res, data, "Segment created.", 201);
}));
admin.get("/segments/:id", authorize("segments.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await segments.getSegment(req.params.id), "Segment.")));
admin.patch("/segments/:id", authorize("segments.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await segments.saveSegment(req.params.id, req.body, actorOf(req)), "Segment saved.")));
admin.post("/segments/:id/import", authorize("segments.manage"), idParam(), body("phones").optional().isArray({ max: 200000 }), body("userIds").optional().isArray({ max: 200000 }), body("csv").optional().isString().isLength({ max: 5_000_000 }), body("mode").optional().isIn(["replace", "append"]), validate, asyncHandler(async (req, res) => {
  const phones = req.body.phones || (req.body.csv ? req.body.csv.split(/[\r\n,;]+/).map((cell) => cell.trim()).filter((cell) => /\d{10}/.test(cell.replace(/\D/g, ""))) : []);
  const data = await segments.importStatic(req.params.id, { phones, userIds: req.body.userIds || [], mode: req.body.mode || "replace" });
  await recordAudit(req, { action: "segment.imported", entityType: "segment", entityId: data.segmentId, summary: `Imported ${data.matched} people into ${data.name}`, diff: false });
  return ok(res, data, "Imported.");
}));

admin.get("/campaigns", authorize("campaigns.manage"), pageQuery, query("status").optional().isString(), validate, asyncHandler(async (req, res) => {
  const { page, limit } = paging(req.query);
  return ok(res, await campaigns.listCampaigns({ ...req.query, page, limit }), "Campaigns.");
}));
admin.get("/campaigns/:id", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await campaigns.getCampaign(req.params.id), "Campaign.")));
admin.get("/campaigns/:id/stats", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await campaigns.campaignStats(req.params.id), "Campaign stats.")));
admin.post("/campaigns", authorize("campaigns.manage"), asyncHandler(async (req, res) => {
  const data = await campaigns.saveCampaign(null, req.body, actorOf(req));
  await recordAudit(req, { action: "campaign.created", entityType: "campaign", entityId: data.campaignId, summary: `Created campaign ${data.name}`, diff: false });
  return ok(res, data, "Campaign created.", 201);
}));
admin.delete("/campaigns/:id", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await campaigns.deleteDraft(req.params.id), "Draft deleted.")));
admin.patch("/campaigns/:id", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await campaigns.saveCampaign(req.params.id, req.body, actorOf(req)), "Campaign saved.")));
admin.post("/campaigns/:id/submit", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const data = await campaigns.submit(req.params.id, actorOf(req));
  await recordAudit(req, { action: "campaign.submitted", entityType: "campaign", entityId: data.campaignId, summary: `${data.name}: ${data.status === "pending_approval" ? "sent for approval" : "scheduled"} (${data.audienceSize} people)`, diff: false });
  return ok(res, data, data.status === "pending_approval" ? "Sent for approval." : "Scheduled.");
}));
admin.post("/campaigns/:id/:decision", authorize("campaigns.approve"), idParam(), param("decision").isIn(["approve", "reject"]), body("note").optional().isString().isLength({ max: 300 }), validate, asyncHandler(async (req, res) => {
  const data = await campaigns.approve(req.params.id, { approve: req.params.decision === "approve", note: req.body.note }, actorOf(req));
  await recordAudit(req, { action: `campaign.${req.params.decision === "approve" ? "approved" : "rejected"}`, entityType: "campaign", entityId: data.campaignId, summary: `${data.name} ${req.params.decision}d`, reason: req.body.note || null, diff: false });
  return ok(res, data, "Campaign reviewed.");
}));
admin.post("/campaigns/:id/control/:action", authorize("campaigns.manage"), idParam(), param("action").isIn(["pause", "resume", "cancel"]), validate, asyncHandler(async (req, res) => {
  const data = await campaigns.control(req.params.id, req.params.action);
  await recordAudit(req, { action: `campaign.${req.params.action}`, entityType: "campaign", entityId: data.campaignId, summary: `${data.name}: ${req.params.action}`, diff: false });
  return ok(res, data, "Campaign updated.");
}));

admin.get("/journeys", authorize("journeys.manage"), asyncHandler(async (req, res) => ok(res, await journeys.listJourneys(), "Journeys.")));
admin.get("/journeys/:id/stats", authorize("journeys.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await journeys.journeyStats(req.params.id), "Journey stats.")));
admin.post("/journeys", authorize("journeys.manage"), body("key").matches(/^[a-z0-9_]{3,40}$/), validate, asyncHandler(async (req, res) => ok(res, await journeys.saveJourney(null, req.body), "Journey created.", 201)));
admin.patch("/journeys/:id", authorize("journeys.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await journeys.saveJourney(req.params.id, req.body), "Journey saved.")));
admin.post("/journeys/:id/:action", authorize("journeys.manage"), idParam(), param("action").isIn(["activate", "deactivate"]), validate, asyncHandler(async (req, res) => {
  const data = await journeys.setJourneyStatus(req.params.id, req.params.action === "activate" ? "active" : "inactive");
  await recordAudit(req, { action: `journey.${req.params.action}d`, entityType: "journey", entityId: data.journeyId, summary: `${data.name} ${req.params.action}d`, diff: false });
  return ok(res, data, "Journey updated.");
}));

admin.get("/in-app-messages", authorize("campaigns.manage"), asyncHandler(async (req, res) => ok(res, (await inapp.InAppMessage.find().sort({ updatedAt: -1 }).lean()).map(inapp.toInApp), "In-app messages.")));
admin.post("/in-app-messages", authorize("campaigns.manage"), asyncHandler(async (req, res) => ok(res, await inapp.saveInApp(null, req.body), "Message created.", 201)));
admin.delete("/in-app-messages/:id", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const row = await inapp.InAppMessage.findByIdAndDelete(req.params.id);
  if (!row) throw new AppError(404, "Message not found");
  return ok(res, { deleted: true }, "Message deleted.");
}));
admin.patch("/in-app-messages/:id", authorize("campaigns.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await inapp.saveInApp(req.params.id, req.body), "Message saved.")));

admin.get("/users/:id/consents", authorize("users.read"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await currentConsents(req.params.id), "Consents.")));
admin.get("/users/:id/traits", authorize("users.read"), idParam(), query("refresh").optional().isBoolean().toBoolean(), validate, asyncHandler(async (req, res) => {
  if (req.query.refresh) await computeTraits(req.params.id);
  const traits = await UserStats.findOne({ user: req.params.id }).lean();
  return ok(res, traits, "Traits.");
}));

// WhatsApp template approval status (synced manually or from the BSP dashboard).
admin.patch("/notification-templates/:key/whatsapp-status", authorize("templates.manage"), param("key").matches(/^[a-z0-9_.]{3,60}$/), body("approvalStatus").isIn(["pending", "approved", "rejected"]), validate, asyncHandler(async (req, res) => {
  const template = await NotificationTemplate.findOne({ key: req.params.key }).sort({ version: -1 });
  if (!template?.channels?.whatsapp?.providerTemplateName) throw new AppError(404, "Save the template with a WhatsApp template name first");
  template.channels.whatsapp.approvalStatus = req.body.approvalStatus;
  template.markModified("channels");
  await template.save();
  await recordAudit(req, { action: "template.whatsapp_status", entityType: "template", entityId: req.params.key, summary: `WhatsApp template ${req.params.key}: ${req.body.approvalStatus}`, diff: false });
  return ok(res, { key: template.key, version: template.version, approvalStatus: req.body.approvalStatus }, "Status saved.");
}));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, customer);
  app.use("/api/v1/admin", recordMountPath, admin);
}
