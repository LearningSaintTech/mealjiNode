import { AppError } from "../../common/errors/AppError.js";
import { acquireLock, releaseLock } from "../../infrastructure/redisStore.js";
import { objectId } from "../../common/http.js";
import { nextSequence } from "../../common/sequence.js";
import { escapeRegex } from "../../common/text.util.js";
import { publishEventSafe } from "../../events/eventBus.js";
import { publish } from "../../realtime/hub.js";
import { Order } from "../order/order.model.js";
import { resolveSetting } from "../settings/settings.service.js";
import { assertOwnTicketFile, assertUploadedSize, privateFileLink } from "../upload/upload.service.js";
import { CannedReply, Faq, SupportCategory, SupportTicket, TicketMessage } from "./support.model.js";

// The app's “How can we help you?” tiles (name, icon, two-line subtitle).
export const DEFAULT_CATEGORIES = [
  { key: "order", name: "My Order", subtitle: "Track, modify or\ncancel", icon: "box", issueTypes: ["Missing item", "Wrong item", "Quality", "Late delivery", "Order not received", "Cancel or change"], context: "default" },
  { key: "payment", name: "Payments", subtitle: "UPI, cards, wallets,\nrefunds", icon: "card", issueTypes: ["Payment failed", "Refund status", "Charged twice"], context: "both" },
  { key: "rewards", name: "Offers & Rewards", subtitle: "Coupons, points,\nMeal Ji Plus", icon: "gift", issueTypes: ["Coupon not applied", "Points missing", "Reward code"], context: "default" },
  { key: "account", name: "Account", subtitle: "Profile, addresses,\nsettings", icon: "user", issueTypes: ["Login", "Phone change", "Address", "Delete account"], context: "both" },
  { key: "subscription", name: "Meal Ji Plus", subtitle: "Plans, billing, pauses\nand deliveries", icon: "crown", issueTypes: ["Meal not delivered", "Change plan", "Billing", "Pause or cancel"], context: "subscription" },
  { key: "other", name: "Something else", subtitle: "Anything we missed", icon: "help-circle", issueTypes: [], context: "both" },
];

// Ticket status as the customer reads it.
const STATUS_LABELS = { open: "Open", in_progress: "In progress", pending_customer: "Waiting for your reply", resolved: "Resolved", closed: "Closed" };
const IST_CLOCK = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
const IST_DATE = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const dayKey = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(date));
/** “Today, 3:40 PM”, “Yesterday, 9:05 AM”, “12 Oct”. */
function timeLabel(date) {
  if (!date) return null;
  const clock = IST_CLOCK.format(new Date(date)).replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM");
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  if (dayKey(date) === today) return `Today, ${clock}`;
  if (dayKey(date) === yesterday) return `Yesterday, ${clock}`;
  return IST_DATE.format(new Date(date));
}
/** “We'll reply within 2 hours” / “… within 1 day”. */
function replyByLabel(ticket) {
  if (!ticket.slaDueAt || ["resolved", "closed"].includes(ticket.status)) return null;
  const hours = Math.max(1, Math.round((new Date(ticket.slaDueAt) - new Date(ticket.createdAt || Date.now())) / 3_600_000));
  return hours >= 24 && hours % 24 === 0 ? `We'll reply within ${hours / 24} day${hours === 24 ? "" : "s"}` : `We'll reply within ${hours} hour${hours === 1 ? "" : "s"}`;
}
let categoryNames = null;
async function categoryName(key) {
  if (!categoryNames) {
    const rows = await listCategories({ all: true });
    categoryNames = new Map(rows.map((row) => [row.key, row.name]));
    setTimeout(() => { categoryNames = null; }, 60_000).unref?.();
  }
  return categoryNames.get(key) || key;
}

export function toTicket(ticket, { agent = false, categoryLabel = null } = {}) {
  return {
    ticketId: String(ticket._id),
    number: ticket.number,
    category: ticket.category,
    categoryName: categoryLabel,
    issueType: ticket.issueType,
    subject: ticket.subject,
    description: ticket.description,
    attachments: (ticket.attachments || []).map(privateFileLink),
    orderId: ticket.order ? String(ticket.order._id || ticket.order) : null,
    orderNumber: ticket.order?.orderNumber || null,
    subscriptionId: ticket.subscription ? String(ticket.subscription) : null,
    status: ticket.status,
    statusLabel: STATUS_LABELS[ticket.status] || ticket.status,
    timeLabel: timeLabel(ticket.lastMessageAt || ticket.createdAt),
    replyByLabel: replyByLabel(ticket),
    canReply: ticket.status !== "closed",
    canRate: ticket.status === "resolved" && !ticket.csat?.rating,
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
export const toCategory = (row) => ({ categoryId: row._id ? String(row._id) : null, key: row.key, name: row.name, subtitle: row.subtitle || null, icon: row.icon || null, issueTypes: row.issueTypes || [], context: row.context, slaHours: row.slaHours ?? null, sortOrder: row.sortOrder || 0, isActive: row.isActive !== false });
export const toCanned = (row) => ({ replyId: String(row._id), title: row.title, body: row.body, category: row.category || null });

const toMessage = (message, { forCustomer = false } = {}) => ({
  messageId: String(message._id),
  author: { name: forCustomer && message.author?.role !== "customer" ? "Meal Ji Support" : message.author?.name || null, role: message.author?.role },
  isMine: message.author?.role === "customer",
  body: message.body,
  attachments: (message.attachments || []).map(privateFileLink),
  internal: Boolean(message.internal),
  timeLabel: timeLabel(message.createdAt),
  createdAt: message.createdAt,
});

// ------------------------------------------------------------------ contact cards

/**
 * The contact rows of both Help screens, in the app's wording: “Still need
 * help?” (Live Chat / Call Us / Email Us) and the Meal Ji Plus screen (FAQs /
 * Chat with us / Call support / Email support). Values come from the support settings.
 */
export function contactCards(values, context = "default") {
  const digits = String(values.phone || "").replace(/[^\d+]/g, "");
  const chatOn = Boolean(values.chatEnabled && values.whatsapp);
  const hours = values.phoneHours ? values.phoneHours.replace(/\s*[–-]\s*/, " – ") : null;
  const chat = { key: "chat", icon: "chat", available: chatOn, badge: chatOn ? `≈ ${values.chatEtaMinutes} min` : null };
  const call = { key: "call", icon: "phone", available: Boolean(digits), action: digits ? `tel:${digits}` : null };
  const email = { key: "email", icon: "mail", available: Boolean(values.email), action: values.email ? `mailto:${values.email}` : null };
  const cards = context === "subscription"
    ? [
      { key: "faqs", icon: "help-circle", available: true, title: "FAQs", subtitle: "Plans, billing, pauses and deliveries", buttonLabel: null },
      { ...chat, title: "Chat with us", subtitle: "Fastest help from our subscription team", buttonLabel: null },
      { ...call, title: "Call support", subtitle: values.phone || null, buttonLabel: null },
      { ...email, title: "Email support", subtitle: values.email || null, buttonLabel: null },
    ]
    : [
      { ...chat, title: "Live Chat", subtitle: "Chat with our team", buttonLabel: "Start Chat" },
      { ...call, title: "Call Us", subtitle: [values.phone, hours ? `(${hours})` : null].filter(Boolean).join("\n") || null, buttonLabel: "Call Now" },
      { ...email, title: "Email Us", subtitle: [values.email, values.emailSla ? `We usually reply ${values.emailSla.charAt(0).toLowerCase()}${values.emailSla.slice(1)}` : null].filter(Boolean).join("\n") || null, buttonLabel: "Send Email" },
    ];
  return {
    hoursLabel: hours ? `Available daily • ${hours} IST` : null,
    contactMethods: cards.filter((card) => card.available !== false || card.key === "faqs"),
  };
}

// ------------------------------------------------------------------ catalogue

export async function listCategories({ context = null, all = false } = {}) {
  let rows = await SupportCategory.find(all ? {} : { isActive: true }).sort({ sortOrder: 1 }).lean();
  if (!rows.length) rows = DEFAULT_CATEGORIES.map((item, index) => ({ ...item, sortOrder: index, isActive: true }));
  return rows
    .filter((row) => !context || row.context === "both" || row.context === context)
    .map(toCategory);
}

export async function saveCategory(key, input) {
  categoryNames = null;
  const row = await SupportCategory.findOneAndUpdate({ key: String(key).toLowerCase() }, { $set: { name: input.name, subtitle: input.subtitle || null, icon: input.icon || null, issueTypes: input.issueTypes || [], context: input.context || "both", slaHours: input.slaHours ?? null, sortOrder: input.sortOrder || 0, isActive: input.isActive !== false } }, { upsert: true, new: true }).lean();
  return toCategory(row);
}

export async function listFaqs({ context = "default", q = null, category = null, limit = null, admin = false } = {}) {
  const filter = admin ? {} : { isActive: true, context };
  if (category) filter.category = category;
  if (q) filter.$or = [{ question: { $regex: escapeRegex(q), $options: "i" } }, { answer: { $regex: escapeRegex(q), $options: "i" } }];
  // The app's order first (sortOrder), so “limit=6” is the list on the Help screen.
  let query = Faq.find(filter).sort({ sortOrder: 1, category: 1 });
  if (limit) query = query.limit(limit);
  return (await query.lean()).map(toFaq);
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
  // Two taps on Submit: one request at a time per customer, and the same issue
  // sent again within 2 minutes returns the ticket already made.
  const lockKey = `ticket:create:${userId}`;
  let token = null;
  for (let attempt = 0; attempt < 10 && !token; attempt += 1) {
    token = await acquireLock(lockKey, 15);
    if (!token) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!token) throw new AppError(409, "Your request is already being sent");
  try {
    const recent = await SupportTicket.findOne({ user: userId, category: input.category, description: input.description, createdAt: { $gte: new Date(Date.now() - 120_000) } }).populate("order", "orderNumber").lean();
    if (recent) return { ...toTicket(recent, { categoryLabel: await categoryName(recent.category) }), duplicate: true };
    return await createTicketLocked(userId, input);
  } finally {
    await releaseLock(lockKey, token);
  }
}

async function createTicketLocked(userId, input) {
  const categories = await listCategories({ all: false });
  const chosen = categories.find((category) => category.key === input.category);
  if (!chosen) throw new AppError(422, "Choose a category", [{ field: "category", message: "Choose a category" }]);
  if (input.issueType && chosen.issueTypes.length && !chosen.issueTypes.includes(input.issueType)) {
    throw new AppError(422, "Choose an issue from the list", [{ field: "issueType", message: "Choose an issue from the list" }]);
  }
  let order = null;
  if (input.orderId) {
    order = await Order.findOne({ _id: objectId(input.orderId, "order ID"), user: userId }).lean();
    if (!order) throw new AppError(404, "Order not found");
  }
  // Only the customer's own subscription can be attached (an agent may act on it).
  let subscription = null;
  if (input.subscriptionId) {
    const { Subscription } = await import("../subscription/subscription.model.js");
    subscription = await Subscription.findOne({ _id: objectId(input.subscriptionId, "subscription ID"), user: userId }).select("_id").lean();
    if (!subscription) throw new AppError(404, "Subscription not found");
  }
  const sequence = await nextSequence("ticket");
  const slaHours = await slaHoursFor(input.category);
  const ticket = await SupportTicket.create({
    number: `T-${100000 + sequence}`,
    user: userId,
    category: input.category,
    issueType: input.issueType || null,
    order: order?._id || null,
    subscription: subscription?._id || null,
    kitchen: order?.kitchen || null,
    subject: input.subject || null,
    description: input.description,
    attachments: await Promise.all((input.attachments || []).slice(0, 5).map((url) => assertUploadedSize(assertOwnTicketFile(url, userId), "ticket"))),
    priority: ["order", "payment"].includes(input.category) ? "high" : "normal",
    priorityRank: ["order", "payment"].includes(input.category) ? PRIORITY_RANK.high : PRIORITY_RANK.normal,
    slaDueAt: new Date(Date.now() + slaHours * 3600_000),
  });
  await TicketMessage.create({ ticket: ticket._id, author: { userId, role: "customer" }, body: input.description, attachments: ticket.attachments });
  await publishEventSafe("ticket.created", { ticketId: String(ticket._id), userId: String(userId), category: ticket.category, number: ticket.number });
  publish("admin:ops", "support:ticket_new", { ticketId: String(ticket._id), number: ticket.number, category: ticket.category, priority: ticket.priority });
  return toTicket({ ...ticket.toObject(), order: order ? { _id: order._id, orderNumber: order.orderNumber } : null }, { categoryLabel: chosen.name });
}

export async function myTickets(userId, { page = 1, limit = 20 }) {
  const filter = { user: userId };
  const [items, total] = await Promise.all([
    SupportTicket.find(filter).populate("order", "orderNumber").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SupportTicket.countDocuments(filter),
  ]);
  const names = new Map((await listCategories({ all: true })).map((row) => [row.key, row.name]));
  return { items: items.map((ticket) => toTicket(ticket, { categoryLabel: names.get(ticket.category) || ticket.category })), page, limit, total, hasMore: page * limit < total };
}

export async function ticketDetail(ticketId, { userId = null, agent = false }) {
  const filter = { _id: objectId(ticketId, "ticket ID"), ...(userId ? { user: userId } : {}) };
  const ticket = await SupportTicket.findOne(filter).populate("order", "orderNumber status").populate("user", "name phoneNumber").lean();
  if (!ticket) throw new AppError(404, "Ticket not found");
  const messages = await TicketMessage.find({ ticket: ticket._id, ...(agent ? {} : { internal: false }) }).sort({ createdAt: 1 }).lean();
  return { ...toTicket(ticket, { agent, categoryLabel: await categoryName(ticket.category) }), messages: messages.map((message) => toMessage(message, { forCustomer: !agent })) };
}

export async function addMessage(ticketId, { body, attachments = [], internal = false }, { userId, name, role }) {
  const filter = { _id: objectId(ticketId, "ticket ID"), ...(role === "customer" ? { user: userId } : {}) };
  const ticket = await SupportTicket.findOne(filter);
  if (!ticket) throw new AppError(404, "Ticket not found");
  if (ticket.status === "closed") throw new AppError(409, "This ticket is closed. Open a new one.");
  const message = await TicketMessage.create({ ticket: ticket._id, author: { userId, name, role }, body, attachments: await Promise.all((Array.isArray(attachments) ? attachments : []).slice(0, 5).map((url) => assertUploadedSize(assertOwnTicketFile(url, userId), "ticket"))), internal: role === "agent" && internal });
  ticket.lastMessageAt = new Date();
  if (role === "agent" && !internal) {
    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
    if (ticket.status === "open") ticket.status = "in_progress";
    await publishEventSafe("ticket.updated", { ticketId: String(ticket._id), userId: String(ticket.user), number: ticket.number, status: ticket.status, message: body.slice(0, 140) });
  }
  if (role === "customer" && ["pending_customer", "resolved"].includes(ticket.status)) ticket.status = "in_progress";
  await ticket.save();
  return toMessage(message.toObject(), { forCustomer: role === "customer" });
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
  const id = objectId(ticketId, "ticket ID");
  // One rating per ticket (two taps cannot both count), only once it is resolved.
  const rated = await SupportTicket.findOneAndUpdate(
    { _id: id, user: userId, status: "resolved", "csat.rating": { $in: [null, undefined] } },
    { $set: { csat: { rating, comment: comment || null, at: new Date() }, status: "closed" } },
    { new: true },
  ).lean();
  if (rated) return toTicket(rated, { categoryLabel: await categoryName(rated.category) });
  const ticket = await SupportTicket.findOne({ _id: id, user: userId }).lean();
  if (!ticket) throw new AppError(404, "Ticket not found");
  if (ticket.csat?.rating) throw new AppError(409, "You already rated this ticket");
  throw new AppError(409, "Rate the ticket once it is resolved");
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
