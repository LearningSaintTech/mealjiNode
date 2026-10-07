import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { nextSequence } from "../../common/sequence.js";
import { escapeRegex } from "../../common/text.util.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { publish } from "../../realtime/hub.js";
import { Order } from "../order/order.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { CannedReply, Faq, SupportCategory, SupportTicket, TicketMessage } from "./support.model.js";

const DEFAULT_CATEGORIES = [
  { key: "order", name: "Order issues", icon: "bag", issueTypes: ["Missing item", "Wrong item", "Quality", "Late delivery", "Order not received"], context: "default" },
  { key: "payment", name: "Payments & refunds", icon: "wallet", issueTypes: ["Payment failed", "Refund status", "Charged twice"], context: "both" },
  { key: "subscription", name: "MealJi Plus", icon: "crown", issueTypes: ["Meal not delivered", "Change plan", "Billing", "Pause or cancel"], context: "subscription" },
  { key: "account", name: "Account", icon: "user", issueTypes: ["Login", "Phone change", "Delete account"], context: "both" },
  { key: "other", name: "Something else", icon: "help", issueTypes: [], context: "both" },
];

export function toTicket(ticket, { agent = false } = {}) {
  return {
    ticketId: String(ticket._id),
    number: ticket.number,
    category: ticket.category,
    issueType: ticket.issueType,
    subject: ticket.subject,
    description: ticket.description,
    attachments: ticket.attachments || [],
    orderId: ticket.order ? String(ticket.order._id || ticket.order) : null,
    orderNumber: ticket.order?.orderNumber || null,
    subscriptionId: ticket.subscription ? String(ticket.subscription) : null,
    status: ticket.status,
    slaDueAt: ticket.slaDueAt,
    csat: ticket.csat?.rating ? ticket.csat : null,
    createdAt: ticket.createdAt,
    lastMessageAt: ticket.lastMessageAt,
    resolvedAt: ticket.resolvedAt,
    ...(agent ? {
      priority: ticket.priority,
      assignee: ticket.assignee?.userId ? { userId: String(ticket.assignee.userId), name: ticket.assignee.name } : null,
      slaBreached: ticket.slaBreached,
      firstResponseAt: ticket.firstResponseAt,
      customer: ticket.user?.name ? { userId: String(ticket.user._id), name: ticket.user.name, phone: ticket.user.phoneNumber } : { userId: String(ticket.user) },
      kitchenId: ticket.kitchen ? String(ticket.kitchen) : null,
    } : {}),
  };
}

export const PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

export const toFaq = (row) => ({ faqId: String(row._id), category: row.category, question: row.question, answer: row.answer, context: row.context, sortOrder: row.sortOrder, isActive: row.isActive, views: row.views || 0 });
export const toCategory = (row) => ({ categoryId: row._id ? String(row._id) : null, key: row.key, name: row.name, icon: row.icon || null, issueTypes: row.issueTypes || [], context: row.context, slaHours: row.slaHours ?? null, sortOrder: row.sortOrder || 0, isActive: row.isActive !== false });
export const toCanned = (row) => ({ replyId: String(row._id), title: row.title, body: row.body, category: row.category || null });

const toMessage = (message) => ({ messageId: String(message._id), author: { name: message.author?.name || null, role: message.author?.role }, body: message.body, attachments: message.attachments || [], internal: Boolean(message.internal), createdAt: message.createdAt });

// ------------------------------------------------------------------ catalogue

export async function listCategories({ context = null, all = false } = {}) {
  let rows = await SupportCategory.find(all ? {} : { isActive: true }).sort({ sortOrder: 1 }).lean();
  if (!rows.length) rows = DEFAULT_CATEGORIES.map((item, index) => ({ ...item, sortOrder: index, isActive: true }));
  return rows
    .filter((row) => !context || row.context === "both" || row.context === context)
    .map(toCategory);
}

export async function saveCategory(key, input) {
  const row = await SupportCategory.findOneAndUpdate({ key: String(key).toLowerCase() }, { $set: { name: input.name, icon: input.icon || null, issueTypes: input.issueTypes || [], context: input.context || "both", slaHours: input.slaHours ?? null, sortOrder: input.sortOrder || 0, isActive: input.isActive !== false } }, { upsert: true, new: true }).lean();
  return toCategory(row);
}

export async function listFaqs({ context = "default", q = null, admin = false } = {}) {
  const filter = admin ? {} : { isActive: true, context };
  if (q) filter.$or = [{ question: { $regex: escapeRegex(q), $options: "i" } }, { answer: { $regex: escapeRegex(q), $options: "i" } }];
  const rows = await Faq.find(filter).sort({ category: 1, sortOrder: 1 }).lean();
  return rows.map(toFaq);
}

export async function saveFaq(faqId, input) {
  const data = {};
  for (const key of ["category", "question", "answer", "context", "sortOrder", "isActive"]) if (input[key] !== undefined) data[key] = input[key];
  if (!faqId && (!data.category || !data.question || !data.answer)) throw new AppError(422, "Category, question and answer are required");
  const faq = faqId ? await Faq.findByIdAndUpdate(objectId(faqId, "FAQ ID"), { $set: data }, { new: true }) : await Faq.create(data);
  if (!faq) throw new AppError(404, "FAQ not found");
  return toFaq(faq.toObject());
}

// ------------------------------------------------------------------ tickets

async function slaHoursFor(category) {
  const [setting, row] = await Promise.all([resolveSetting("support"), SupportCategory.findOne({ key: category }).lean()]);
  return row?.slaHours || setting.values.ticketSlaHours;
}

export async function createTicket(userId, input) {
  const categories = await listCategories({ all: false });
  if (!categories.some((category) => category.key === input.category)) throw new AppError(422, "Choose a category");
  let order = null;
  if (input.orderId) {
    order = await Order.findOne({ _id: objectId(input.orderId, "order ID"), user: userId }).lean();
    if (!order) throw new AppError(404, "Order not found");
  }
  const sequence = await nextSequence("ticket");
  const slaHours = await slaHoursFor(input.category);
  const ticket = await SupportTicket.create({
    number: `T-${100000 + sequence}`,
    user: userId,
    category: input.category,
    issueType: input.issueType || null,
    order: order?._id || null,
    subscription: input.subscriptionId || null,
    kitchen: order?.kitchen || null,
    subject: input.subject || null,
    description: input.description,
    attachments: (input.attachments || []).slice(0, 5).map((url) => assertOwnFileUrl(url, "Attachment")),
    priority: ["order", "payment"].includes(input.category) ? "high" : "normal",
    priorityRank: ["order", "payment"].includes(input.category) ? PRIORITY_RANK.high : PRIORITY_RANK.normal,
    slaDueAt: new Date(Date.now() + slaHours * 3600_000),
  });
  await TicketMessage.create({ ticket: ticket._id, author: { userId, role: "customer" }, body: input.description, attachments: ticket.attachments });
  await publishEventSafe("ticket.created", { ticketId: String(ticket._id), userId: String(userId), category: ticket.category, number: ticket.number });
  publish("admin:ops", "support:ticket_new", { ticketId: String(ticket._id), number: ticket.number, category: ticket.category, priority: ticket.priority });
  return toTicket(ticket.toObject());
}

export async function myTickets(userId, { page = 1, limit = 20 }) {
  const filter = { user: userId };
  const [items, total] = await Promise.all([
    SupportTicket.find(filter).populate("order", "orderNumber").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SupportTicket.countDocuments(filter),
  ]);
  return { items: items.map((ticket) => toTicket(ticket)), page, limit, total };
}

export async function ticketDetail(ticketId, { userId = null, agent = false }) {
  const filter = { _id: objectId(ticketId, "ticket ID"), ...(userId ? { user: userId } : {}) };
  const ticket = await SupportTicket.findOne(filter).populate("order", "orderNumber status").populate("user", "name phoneNumber").lean();
  if (!ticket) throw new AppError(404, "Ticket not found");
  const messages = await TicketMessage.find({ ticket: ticket._id, ...(agent ? {} : { internal: false }) }).sort({ createdAt: 1 }).lean();
  return { ...toTicket(ticket, { agent }), messages: messages.map(toMessage) };
}

export async function addMessage(ticketId, { body, attachments = [], internal = false }, { userId, name, role }) {
  const filter = { _id: objectId(ticketId, "ticket ID"), ...(role === "customer" ? { user: userId } : {}) };
  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw new AppError(404, "Ticket not found");
  if (ticket.status === "closed") throw new AppError(409, "This ticket is closed. Open a new one.");
  const message = await TicketMessage.create({ ticket: ticket._id, author: { userId, name, role }, body, attachments: attachments.slice(0, 5).map((url) => assertOwnFileUrl(url, "Attachment")), internal: role === "agent" && internal });
  ticket.lastMessageAt = new Date();
  if (role === "agent" && !internal) {
    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    if (ticket.status === "open") ticket.status = "in_progress";
    await publishEventSafe("ticket.updated", { ticketId: String(ticket._id), userId: String(ticket.user), number: ticket.number, status: ticket.status, message: body.slice(0, 140) });
  }
  if (role === "customer" && ["pending_customer", "resolved"].includes(ticket.status)) ticket.status = "in_progress";
  await ticket.save();
  return toMessage(message.toObject());
}

export async function setStatus(ticketId, { status, priority, assigneeId, assigneeName }) {
  const ticket = await SupportTicket.findById(objectId(ticketId, "ticket ID"));
  if (!ticket) throw new AppError(404, "Ticket not found");
  const before = { status: ticket.status, priority: ticket.priority, assignee: ticket.assignee?.name || null };
  if (status) {
    ticket.status = status;
    if (status === "resolved") ticket.resolvedAt = new Date();
  }
  if (priority) {
    ticket.priority = priority;
    ticket.priorityRank = PRIORITY_RANK[priority];
  }
  if (assigneeId !== undefined) ticket.assignee = assigneeId ? { userId: assigneeId, name: assigneeName || null } : { userId: null, name: null };
  await ticket.save();
  if (status && status !== before.status) {
    await TicketMessage.create({ ticket: ticket._id, author: { role: "system" }, body: `Status changed to ${status.replace("_", " ")}` });
    await publishEventSafe("ticket.updated", { ticketId: String(ticket._id), userId: String(ticket.user), number: ticket.number, status, message: `Your ticket is now ${status.replace("_", " ")}` });
  }
  const full = await SupportTicket.findById(ticket._id).populate("user", "name phoneNumber").populate("order", "orderNumber").lean();
  return { before, after: { status: ticket.status, priority: ticket.priority, assignee: ticket.assignee?.name || null }, ticket: toTicket(full, { agent: true }) };
}

export async function rateTicket(userId, ticketId, { rating, comment }) {
  const ticket = await SupportTicket.findOne({ _id: objectId(ticketId, "ticket ID"), user: userId });
  if (!ticket) throw new AppError(404, "Ticket not found");
  if (!["resolved", "closed"].includes(ticket.status)) throw new AppError(409, "Rate the ticket once it is resolved");
  ticket.csat = { rating, comment: comment || null, at: new Date() };
  ticket.status = "closed";
  await ticket.save();
  return toTicket(ticket.toObject());
}

export async function queue({ status, category, assigneeId, mine, q, breached, page = 1, limit = 25 }, agentId) {
  const filter = {};
  if (status === "active") filter.status = { $in: ["open", "in_progress", "pending_customer"] };
  else if (status) filter.status = status;
  if (category) filter.category = category;
  if (mine) filter["assignee.userId"] = agentId;
  else if (assigneeId) filter["assignee.userId"] = assigneeId;
  if (breached) filter.slaBreached = true;
  if (q) filter.number = { $regex: escapeRegex(q.toUpperCase()) };
  const [items, total, counts] = await Promise.all([
    SupportTicket.find(filter).populate("user", "name phoneNumber").populate("order", "orderNumber").sort({ slaBreached: -1, priorityRank: -1, slaDueAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    SupportTicket.countDocuments(filter),
    SupportTicket.aggregate([{ $group: { _id: "$status", total: { $sum: 1 } } }]),
  ]);
  return { items: items.map((ticket) => toTicket(ticket, { agent: true })), counts: Object.fromEntries(counts.map((row) => [row._id, row.total])), page, limit, total };
}

/** Every 5 minutes: flags tickets past their SLA and alerts the ops room. */
export async function slaWatchdog() {
  const breached = await SupportTicket.find({ status: { $in: ["open", "in_progress"] }, slaBreached: false, slaDueAt: { $lt: new Date() } }).limit(200);
  for (const ticket of breached) {
    ticket.slaBreached = true;
    await ticket.save();
    publish("admin:ops", "support:sla_breach", { ticketId: String(ticket._id), number: ticket.number });
  }
  return breached.length;
}

export async function listCanned() {
  return (await CannedReply.find().sort({ title: 1 }).lean()).map(toCanned);
}

export async function saveCanned(replyId, input) {
  if (!input.title || !input.body) throw new AppError(422, "Title and text are required");
  const row = replyId ? await CannedReply.findByIdAndUpdate(objectId(replyId, "reply ID"), { $set: input }, { new: true }) : await CannedReply.create(input);
  if (!row) throw new AppError(404, "Reply not found");
  return toCanned(row.toObject ? row.toObject() : row);
}

export async function deleteCanned(replyId) {
  const row = await CannedReply.findByIdAndDelete(objectId(replyId, "reply ID"));
  if (!row) throw new AppError(404, "Reply not found");
  return { replyId, deleted: true };
}
