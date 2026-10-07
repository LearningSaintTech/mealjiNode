import mongoose from "mongoose";

// The legal entity that issues tax invoices (one for all kitchens, or one per
// kitchen/franchise). Kitchens point at an entity; the default entity covers
// kitchens that are not mapped.
const billingEntitySchema = new mongoose.Schema(
  {
    legalName: { type: String, required: true, trim: true, maxlength: 160 },
    tradeName: { type: String, default: null, trim: true, maxlength: 120 },
    gstin: { type: String, default: null, trim: true, uppercase: true },
    fssai: { type: String, default: null, trim: true },
    pan: { type: String, default: null, trim: true, uppercase: true },
    addressLine: { type: String, required: true, trim: true, maxlength: 240 },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    stateCode: { type: String, default: null, trim: true }, // GST state code, e.g. "29" for Karnataka
    pincode: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true },
    phone: { type: String, default: null, trim: true },
    invoicePrefix: { type: String, required: true, trim: true, uppercase: true, maxlength: 8 },
    logoUrl: { type: String, default: null },
    signatory: { type: String, default: null, trim: true },
    bank: {
      accountName: { type: String, default: null },
      accountNumber: { type: String, default: null },
      ifsc: { type: String, default: null },
    },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

billingEntitySchema.index({ invoicePrefix: 1 }, { unique: true });

export const BillingEntity = mongoose.model("BillingEntity", billingEntitySchema);

// A tax invoice / receipt. Numbers are sequential per entity per financial year.
const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true },
    financialYear: { type: String, required: true },
    entity: { type: mongoose.Schema.Types.ObjectId, ref: "BillingEntity", required: true },
    entitySnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kitchen: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", default: null },
    refType: { type: String, enum: ["order", "subscription"], required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },
    periodLabel: { type: String, default: null },
    customer: {
      name: { type: String, default: null },
      phone: { type: String, default: null },
      email: { type: String, default: null },
      address: { type: String, default: null },
      state: { type: String, default: null },
    },
    lines: [{
      _id: false,
      description: String,
      sac: String,
      qty: Number,
      unitPaise: Number,
      taxablePaise: Number,
      ratePercent: Number,
      cgstPaise: Number,
      sgstPaise: Number,
      igstPaise: Number,
      totalPaise: Number,
    }],
    taxablePaise: { type: Number, required: true },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true },
    placeOfSupply: { type: String, default: null },
    status: { type: String, enum: ["issued", "cancelled"], default: "issued" },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

invoiceSchema.index({ entity: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ refType: 1, refId: 1 });
invoiceSchema.index({ user: 1, issuedAt: -1 });
invoiceSchema.index({ issuedAt: -1 });

export const Invoice = mongoose.model("Invoice", invoiceSchema);
