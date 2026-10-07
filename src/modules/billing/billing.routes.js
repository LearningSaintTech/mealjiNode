import { Router } from "express";
import { body, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { has, idParam, ok, pageQuery, pageResult, paging, requireAnyPermission } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import { Invoice } from "./billing.model.js";
import * as billing from "./billing.service.js";

const entityBody = (optional) => {
  const req = (chain) => (optional ? chain.optional() : chain);
  return [
    req(body("legalName")).isString().trim().isLength({ min: 2, max: 160 }).withMessage("Legal name is required"),
    body("tradeName").optional({ values: "null" }).isString().isLength({ max: 120 }),
    body("gstin").optional({ values: "falsy" }).matches(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i).withMessage("Invalid GSTIN"),
    body("fssai").optional({ values: "falsy" }).matches(/^\d{14}$/).withMessage("FSSAI number is 14 digits"),
    body("pan").optional({ values: "falsy" }).matches(/^[A-Z]{5}\d{4}[A-Z]$/i).withMessage("Invalid PAN"),
    req(body("addressLine")).isString().trim().isLength({ min: 3, max: 240 }).withMessage("Address is required"),
    req(body("city")).isString().trim().notEmpty().withMessage("City is required"),
    req(body("state")).isString().trim().notEmpty().withMessage("State is required"),
    body("stateCode").optional({ values: "falsy" }).matches(/^\d{2}$/).withMessage("GST state code is 2 digits"),
    body("pincode").optional({ values: "falsy" }).matches(/^\d{6}$/).withMessage("Pincode must be 6 digits"),
    body("email").optional({ values: "falsy" }).isEmail(),
    req(body("invoicePrefix")).isString().trim().matches(/^[A-Z0-9]{2,8}$/i).withMessage("Prefix: 2 to 8 letters or digits"),
    body("isDefault").optional().isBoolean(),
    body("isActive").optional().isBoolean(),
  ];
};

export const adminBillingRouter = Router();
adminBillingRouter.use(authMiddleware);

adminBillingRouter.get("/billing-entities", requireAnyPermission("settings.read", "invoices.read", "settings.billing_entities"), asyncHandler(async (req, res) => (
  ok(res, await billing.listEntities(), "Billing entities fetched.")
)));
adminBillingRouter.post("/billing-entities", authorize("settings.billing_entities"), entityBody(false), validate, asyncHandler(async (req, res) => {
  const data = await billing.createEntity(req.body);
  await recordAudit(req, { action: "billing_entity.created", entityType: "billing_entity", entityId: data.entityId, summary: `Created billing entity ${data.legalName}`, after: data, diff: false });
  return ok(res, data, "Billing entity created.", 201);
}));
adminBillingRouter.patch("/billing-entities/:id", authorize("settings.billing_entities"), idParam(), entityBody(true), validate, asyncHandler(async (req, res) => {
  const { before, after } = await billing.updateEntity(req.params.id, req.body);
  await recordAudit(req, { action: "billing_entity.updated", entityType: "billing_entity", entityId: after.entityId, summary: `Updated billing entity ${after.legalName}`, before, after });
  return ok(res, after, "Billing entity updated.");
}));
adminBillingRouter.put(
  "/kitchens/:id/billing-entity",
  authorize("settings.billing_entities"),
  idParam(),
  body("entityId").optional({ values: "null" }).isMongoId().withMessage("Invalid entity ID"),
  validate,
  asyncHandler(async (req, res) => {
    const data = await billing.mapKitchen(req.params.id, req.body.entityId || null);
    await recordAudit(req, { action: "kitchen.billing_entity_changed", entityType: "kitchen", entityId: data.kitchenId, kitchenId: data.kitchenId, summary: `Invoices for ${data.name} now issued by ${data.after || "the default entity"}`, before: { billingEntity: data.before }, after: { billingEntity: data.after } });
    return ok(res, data, "Kitchen mapped.");
  }),
);

adminBillingRouter.get(
  "/invoices",
  authorize("invoices.read"),
  pageQuery,
  query("from").optional().isISO8601(),
  query("to").optional().isISO8601(),
  query("refType").optional().isIn(["order", "subscription"]),
  query("q").optional().isString().isLength({ max: 40 }),
  validate,
  asyncHandler(async (req, res) => {
    const page = paging(req.query);
    const filter = {};
    if (req.query.refType) filter.refType = req.query.refType;
    if (req.query.q) filter.invoiceNumber = { $regex: req.query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    if (req.query.from || req.query.to) {
      filter.issuedAt = {};
      if (req.query.from) filter.issuedAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.issuedAt.$lte = new Date(req.query.to);
    }
    const [items, total] = await Promise.all([
      Invoice.find(filter).sort({ issuedAt: -1 }).skip(page.skip).limit(page.limit).lean(),
      Invoice.countDocuments(filter),
    ]);
    return ok(res, pageResult(items.map(billing.toInvoice), total, page), "Invoices fetched.");
  }),
);

async function sendPdf(res, invoice) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber.replace(/\//g, "-")}.pdf"`);
  return res.send(billing.invoicePdf(invoice));
}

adminBillingRouter.get("/invoices/:id/pdf", authorize("invoices.read"), idParam(), validate, asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice) throw new AppError(404, "Invoice not found");
  return sendPdf(res, invoice);
}));

// Customers: their own invoices (orders and subscriptions).
export const invoiceRouter = Router();
invoiceRouter.use(authMiddleware);
invoiceRouter.get("/", pageQuery, validate, asyncHandler(async (req, res) => {
  const page = paging(req.query);
  const filter = { user: req.auth.userId };
  const [items, total] = await Promise.all([
    Invoice.find(filter).sort({ issuedAt: -1 }).skip(page.skip).limit(page.limit).lean(),
    Invoice.countDocuments(filter),
  ]);
  return ok(res, pageResult(items.map(billing.toInvoice), total, page), "Invoices fetched.");
}));
invoiceRouter.get("/:id", idParam(), validate, asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice || (String(invoice.user) !== req.auth.userId && !has(req, "invoices.read"))) throw new AppError(404, "Invoice not found");
  return ok(res, billing.toInvoice(invoice), "Invoice fetched.");
}));
invoiceRouter.get("/:id/pdf", idParam(), validate, asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice || (String(invoice.user) !== req.auth.userId && !has(req, "invoices.read"))) throw new AppError(404, "Invoice not found");
  return sendPdf(res, invoice);
}));
