import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { PdfDocument, rupees } from "../../common/pdf.js";
import { financialYear, nextSequence } from "../../common/sequence.js";
import { istDateKey } from "../../common/time.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { BillingEntity, Invoice } from "./billing.model.js";
import { memoCache } from "../../common/memoCache.js";

const ENTITY_FIELDS = ["legalName", "tradeName", "gstin", "fssai", "pan", "addressLine", "city", "state", "stateCode", "pincode", "email", "phone", "invoicePrefix", "logoUrl", "signatory", "bank", "isActive"];

export function toEntity(entity) {
  return {
    entityId: String(entity._id),
    legalName: entity.legalName,
    tradeName: entity.tradeName ?? null,
    gstin: entity.gstin ?? null,
    fssai: entity.fssai ?? null,
    pan: entity.pan ?? null,
    addressLine: entity.addressLine,
    city: entity.city,
    state: entity.state,
    stateCode: entity.stateCode ?? null,
    pincode: entity.pincode ?? null,
    email: entity.email ?? null,
    phone: entity.phone ?? null,
    invoicePrefix: entity.invoicePrefix,
    logoUrl: entity.logoUrl ?? null,
    signatory: entity.signatory ?? null,
    bank: entity.bank || {},
    isDefault: Boolean(entity.isDefault),
    isActive: entity.isActive !== false,
    updatedAt: entity.updatedAt,
  };
}

export async function listEntities() {
  const entities = await BillingEntity.find().sort({ isDefault: -1, legalName: 1 }).lean();
  const counts = await Kitchen.aggregate([{ $group: { _id: "$billingEntity", total: { $sum: 1 } } }]);
  const byEntity = new Map(counts.map((row) => [String(row._id), row.total]));
  return entities.map((entity) => ({ ...toEntity(entity), kitchens: byEntity.get(String(entity._id)) || 0 }));
}

export async function getEntity(entityId) {
  const entity = await BillingEntity.findById(objectId(entityId, "entity ID"));
  if (!entity) throw new AppError(404, "Billing entity not found");
  return entity;
}

export async function createEntity(input) {
  const data = Object.fromEntries(ENTITY_FIELDS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  const first = (await BillingEntity.countDocuments()) === 0;
  try {
    const entity = await BillingEntity.create({ ...data, isDefault: first || input.isDefault === true });
    if (entity.isDefault && !first) await BillingEntity.updateMany({ _id: { $ne: entity._id } }, { $set: { isDefault: false } });
    entityCache.clear();
    return toEntity(entity);
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "Another entity already uses this invoice prefix");
    throw err;
  }
}

export async function updateEntity(entityId, input) {
  const entity = await getEntity(entityId);
  const before = toEntity(entity);
  for (const key of ENTITY_FIELDS) {
    if (input[key] !== undefined) entity[key] = input[key];
  }
  if (input.isDefault === true && !entity.isDefault) {
    await BillingEntity.updateMany({ _id: { $ne: entity._id } }, { $set: { isDefault: false } });
    entity.isDefault = true;
  }
  try {
    await entity.save();
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "Another entity already uses this invoice prefix");
    throw err;
  }
  entityCache.clear();
  return { before, after: toEntity(entity) };
}

export async function mapKitchen(kitchenId, entityId) {
  const kitchen = await Kitchen.findById(objectId(kitchenId, "kitchen ID"));
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  if (entityId) await getEntity(entityId);
  const before = kitchen.billingEntity ? String(kitchen.billingEntity) : null;
  kitchen.billingEntity = entityId || null;
  await kitchen.save();
  entityCache.clear();
  return { kitchenId: String(kitchen._id), name: kitchen.name, before, after: entityId || null };
}

/** The entity that invoices for a kitchen: its mapping, else the default entity. */
// The invoicing entity behind a kitchen (for GST on every bill): 30 s in memory.
export const entityCache = memoCache(30_000);

export function entityForKitchen(kitchenId) {
  return entityCache.get(String(kitchenId || ""), () => loadEntityForKitchen(kitchenId));
}

async function loadEntityForKitchen(kitchenId) {
  const { kitchenRepository } = await import("../kitchen/kitchen.repository.js");
  const kitchen = kitchenId ? await kitchenRepository.findActiveById(kitchenId) : null;
  if (kitchen?.billingEntity) {
    const mapped = await BillingEntity.findById(kitchen.billingEntity).lean();
    if (mapped?.isActive !== false && mapped) return mapped;
  }
  return BillingEntity.findOne({ isDefault: true, isActive: { $ne: false } }).lean();
}

/**
 * Issues a tax invoice for a paid order or subscription cycle. Idempotent per
 * reference: re-issuing returns the existing invoice. Returns null when no
 * billing entity is configured yet (the order still completes; finance is
 * alerted by the report of uninvoiced orders).
 */
export async function issueInvoice({ refType, refId, userId, kitchenId = null, customer, lines, totals, placeOfSupply = null, periodLabel = null, session = null }) {
  const existing = await Invoice.findOne({ refType, refId }).session(session || null);
  if (existing) return existing;
  const entity = await entityForKitchen(kitchenId);
  if (!entity) return null;
  const fy = financialYear();
  const sequence = await nextSequence(`invoice:${entity._id}:${fy}`, { session });
  const invoiceNumber = `${entity.invoicePrefix}/${fy}/${String(sequence).padStart(6, "0")}`;
  const [invoice] = await Invoice.create([{
    invoiceNumber,
    financialYear: fy,
    entity: entity._id,
    entitySnapshot: toEntity(entity),
    user: userId,
    kitchen: kitchenId,
    refType,
    refId,
    periodLabel,
    customer,
    lines,
    taxablePaise: totals.taxablePaise,
    cgstPaise: totals.cgstPaise || 0,
    sgstPaise: totals.sgstPaise || 0,
    igstPaise: totals.igstPaise || 0,
    totalPaise: totals.totalPaise,
    placeOfSupply,
  }], session ? { session } : {});
  return invoice;
}

/** Invoice lines from a computed bill (pricing engine output) and order items. */
export function invoiceLinesFromBill(bill, items) {
  const lines = [];
  const food = bill.taxes.lines.find((line) => line.type === "food");
  if (food) {
    lines.push({
      description: items.map((item) => `${item.name} x${item.qty}`).join(", ").slice(0, 300) || "Food",
      sac: food.sac || "996331",
      qty: 1,
      unitPaise: food.taxablePaise,
      taxablePaise: food.taxablePaise,
      ratePercent: food.ratePercent,
      cgstPaise: food.cgst,
      sgstPaise: food.sgst,
      igstPaise: food.igst,
      totalPaise: food.taxablePaise + food.total,
    });
  }
  const labels = { delivery: "Delivery charges", packaging: "Packaging charges", fees: "Platform and other fees" };
  for (const line of bill.taxes.lines.filter((item) => item.type !== "food")) {
    lines.push({
      description: labels[line.type] || line.type,
      sac: line.sac || "",
      qty: 1,
      unitPaise: line.taxablePaise,
      taxablePaise: line.taxablePaise,
      ratePercent: line.ratePercent,
      cgstPaise: line.cgst,
      sgstPaise: line.sgst,
      igstPaise: line.igst,
      totalPaise: line.taxablePaise + line.total,
    });
  }
  return lines;
}

export function toInvoice(invoice) {
  return {
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    financialYear: invoice.financialYear,
    refType: invoice.refType,
    refId: String(invoice.refId),
    periodLabel: invoice.periodLabel,
    date: istDateKey(invoice.issuedAt),
    issuedAt: invoice.issuedAt,
    entity: invoice.entitySnapshot,
    customer: invoice.customer,
    lines: invoice.lines,
    taxablePaise: invoice.taxablePaise,
    gst: { cgstPaise: invoice.cgstPaise, sgstPaise: invoice.sgstPaise, igstPaise: invoice.igstPaise },
    totalPaise: invoice.totalPaise,
    status: invoice.status,
    pdfPath: `/invoices/${invoice._id}/pdf`,
  };
}

export function invoicePdf(invoice) {
  const entity = invoice.entitySnapshot || {};
  const doc = new PdfDocument();
  doc.line(entity.tradeName || entity.legalName || "MealJi", { size: 16, bold: true });
  doc.line(entity.legalName || "", { size: 9 });
  doc.line([entity.addressLine, entity.city, entity.state, entity.pincode].filter(Boolean).join(", "), { size: 9 });
  doc.line([entity.gstin ? `GSTIN ${entity.gstin}` : null, entity.fssai ? `FSSAI ${entity.fssai}` : null].filter(Boolean).join("   "), { size: 9 });
  doc.rule();
  doc.line("TAX INVOICE", { size: 12, bold: true });
  doc.line(`Invoice no. ${invoice.invoiceNumber}    Date ${istDateKey(invoice.issuedAt)}${invoice.periodLabel ? `    Period ${invoice.periodLabel}` : ""}`, { size: 9 });
  doc.line(`Billed to: ${invoice.customer?.name || "Customer"}${invoice.customer?.phone ? `, ${invoice.customer.phone}` : ""}`, { size: 9 });
  if (invoice.customer?.address) doc.line(invoice.customer.address, { size: 9 });
  if (invoice.placeOfSupply) doc.line(`Place of supply: ${invoice.placeOfSupply}`, { size: 9 });
  doc.space(6);
  doc.table(
    [
      { header: "Description", width: 190 },
      { header: "SAC", width: 50 },
      { header: "Taxable", width: 70, align: "right" },
      { header: "Rate", width: 40, align: "right" },
      { header: "CGST", width: 55, align: "right" },
      { header: "SGST", width: 55, align: "right" },
      { header: "IGST", width: 55, align: "right" },
    ],
    (invoice.lines || []).map((line) => [
      String(line.description || "").slice(0, 40),
      line.sac || "",
      rupees(line.taxablePaise),
      `${line.ratePercent}%`,
      rupees(line.cgstPaise),
      rupees(line.sgstPaise),
      rupees(line.igstPaise),
    ]),
  );
  doc.rule();
  doc.line(`Taxable value ${rupees(invoice.taxablePaise)}`, { align: "right", size: 10 });
  doc.line(`CGST ${rupees(invoice.cgstPaise)}   SGST ${rupees(invoice.sgstPaise)}   IGST ${rupees(invoice.igstPaise)}`, { align: "right", size: 10 });
  doc.line(`Total ${rupees(invoice.totalPaise)}`, { align: "right", size: 12, bold: true });
  doc.space(20);
  doc.line(entity.signatory ? `For ${entity.legalName}  -  ${entity.signatory} (Authorised signatory)` : "This is a computer-generated invoice.", { size: 8 });
  return doc.toBuffer();
}
