import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const faqSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, maxlength: 40 },
    question: { type: String, required: true, maxlength: 200 },
    answer: { type: String, required: true, maxlength: 3000 },
    context: { type: String, enum: ["default", "subscription"], default: "default" },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    views: { type: Number, default: 0 },
  },
  { timestamps: true },
);
faqSchema.index({ context: 1, category: 1, sortOrder: 1 });
export const Faq = mongoose.model("Faq", faqSchema);

const categorySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true, maxlength: 60 },
    icon: { type: String, default: null },
    issueTypes: { type: [String], default: [] },
    context: { type: String, enum: ["default", "subscription", "both"], default: "both" },
    slaHours: { type: Number, default: null }, // overrides the support setting
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const SupportCategory = mongoose.model("SupportCategory", categorySchema);

const ticketSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    user: { type: ObjectId, ref: "User", required: true },
    category: { type: String, required: true },
    issueType: { type: String, default: null },
    order: { type: ObjectId, ref: "Order", default: null },
    subscription: { type: ObjectId, ref: "Subscription", default: null },
    kitchen: { type: ObjectId, ref: "Kitchen", default: null },
    subject: { type: String, default: null, maxlength: 120 },
    description: { type: String, required: true, maxlength: 2000 },
    attachments: { type: [String], default: [] },
    // open → in_progress → pending_customer → resolved → closed
    status: { type: String, enum: ["open", "in_progress", "pending_customer", "resolved", "closed"], default: "open" },
    priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal" },
    priorityRank: { type: Number, default: 1 }, // low 0, normal 1, high 2, urgent 3 (for sorting)
    assignee: { userId: { type: ObjectId, ref: "User", default: null }, name: String },
    slaDueAt: { type: Date, required: true },
    slaBreached: { type: Boolean, default: false },
    firstResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    csat: { rating: Number, comment: String, at: Date },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
ticketSchema.index({ status: 1, slaDueAt: 1 });
ticketSchema.index({ user: 1, createdAt: -1 });
ticketSchema.index({ "assignee.userId": 1, status: 1 });
export const SupportTicket = mongoose.model("SupportTicket", ticketSchema);

const messageSchema = new mongoose.Schema(
  {
    ticket: { type: ObjectId, ref: "SupportTicket", required: true },
    author: { userId: ObjectId, name: String, role: { type: String, enum: ["customer", "agent", "system"] } },
    body: { type: String, required: true, maxlength: 4000 },
    attachments: { type: [String], default: [] },
    internal: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
messageSchema.index({ ticket: 1, createdAt: 1 });
export const TicketMessage = mongoose.model("TicketMessage", messageSchema);

const cannedSchema = new mongoose.Schema({ title: { type: String, required: true, maxlength: 80 }, body: { type: String, required: true, maxlength: 2000 }, category: { type: String, default: null } }, { timestamps: true });
export const CannedReply = mongoose.model("CannedReply", cannedSchema);
