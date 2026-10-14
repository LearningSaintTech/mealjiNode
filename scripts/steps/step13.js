// Step 13 · Help and support — Help & Support (Profile / Tracking “Help”),
// Meal Ji Plus Help & Support, FAQs, Report an issue (tickets), ticket
// conversation, rating, Live chat. Demo customer 9000000035; tickets made here
// are removed afterwards.
import mongoose from "mongoose";
import { Client, createSuite, db, DEMO } from "./harness.js";

const APP_CATEGORIES = [
  ["order", "My Order", "box"],
  ["payment", "Payments", "card"],
  ["rewards", "Offers & Rewards", "gift"],
  ["account", "Account", "user"],
];
const APP_FAQS = ["How can I track my order?", "Can I cancel or modify my order?", "How do I get a refund?", "What payment methods are accepted?", "How do Meal Ji Points work?", "What is Meal Ji Plus?"];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function step13(ctx) {
  const s = createSuite("13", "Help and support");
  const database = await db();
  const me = new Client("step13-device-001");
  await me.signIn("9000000035");
  const other = new Client("step13-device-002");
  await other.signIn(DEMO.otherCustomer);
  const admin = new Client("step13-admin-001");
  await admin.signIn(DEMO.admin, { staff: true });
  const userId = new mongoose.Types.ObjectId(me.session.user.userId);
  const startedAt = new Date();
  ctx.cleanups.push(async () => {
    const tickets = await database.collection("supporttickets").find({ user: userId, createdAt: { $gte: startedAt } }).project({ _id: 1 }).toArray();
    await database.collection("ticketmessages").deleteMany({ ticket: { $in: tickets.map((t) => t._id) } });
    await database.collection("supporttickets").deleteMany({ _id: { $in: tickets.map((t) => t._id) } });
    await database.collection("notifications").deleteMany({ user: userId, createdAt: { $gte: startedAt }, category: "account" });
  });

  // ---- Help & Support home
  const config = (await me.call("GET", "/support/config")).data || {};
  await s.run("13-01", "“Still need help?” contact cards in the app's wording", "Live Chat · Call Us · Email Us with their buttons and hours", () => {
    const cards = config.contactMethods || [];
    const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
    return {
      ok: byKey.chat?.title === "Live Chat" && byKey.chat.buttonLabel === "Start Chat" && byKey.call?.title === "Call Us" && byKey.call.buttonLabel === "Call Now" && /^tel:\+?\d+/.test(byKey.call.action) && byKey.email?.title === "Email Us" && byKey.email.buttonLabel === "Send Email" && /^mailto:/.test(byKey.email.action)
        && cards.every((c) => c.subtitle && c.icon) && /^Available daily • /.test(config.hoursLabel || ""),
      detail: `${cards.map((c) => `${c.title} (${c.buttonLabel}) “${c.subtitle?.replace(/\n/g, " ")}”`).join(" · ")} · ${config.hoursLabel}`,
    };
  });
  await s.run("13-02", "“How can we help you?” categories as the app draws them", "My Order · Payments · Offers & Rewards · Account (icon + two-line subtitle)", async () => {
    const cats = (await me.call("GET", "/support/categories")).data || [];
    const plus = (await me.call("GET", "/support/categories?context=subscription")).data || [];
    const ok = APP_CATEGORIES.every(([key, name, icon]) => cats.some((c) => c.key === key && c.name === name && c.icon === icon && c.subtitle));
    return { ok: ok && plus.some((c) => c.key === "subscription"), detail: `${cats.map((c) => `${c.name}/${c.icon} “${(c.subtitle || "").replace(/\n/g, " ")}”`).join(" · ")} | Plus: ${plus.map((c) => c.name).join(", ")}` };
  });
  await s.run("13-03", "Frequently Asked Questions: the app's questions, with answers; View All", "FAQ list (6 on the screen) + View All", async () => {
    const top = (await me.call("GET", "/support/faqs?limit=6")).data || [];
    const all = (await me.call("GET", "/support/faqs")).data || [];
    const plus = (await me.call("GET", "/support/faqs?context=subscription")).data || [];
    return {
      ok: top.length === 6 && APP_FAQS.every((q) => all.some((f) => f.question === q && f.answer)) && all.length >= top.length && plus.length >= 3 && plus.every((f) => f.answer),
      detail: `top ${top.map((f) => f.question).join(" | ")} · all ${all.length} · Plus ${plus.length}`,
    };
  });
  await s.run("13-04", "Search for help, and FAQs by category", "Search box (e.g. order, refund, payment) · tap a category", async () => {
    const refund = (await me.call("GET", "/support/faqs?q=refund")).data || [];
    const none = await me.call("GET", "/support/faqs?q=xyzzy");
    const tooLong = await me.call("GET", `/support/faqs?q=${"a".repeat(61)}`);
    const payments = (await me.call("GET", "/support/faqs?category=payment")).data || [];
    return {
      ok: refund.some((f) => /refund/i.test(f.question)) && none.status === 200 && none.data.length === 0 && tooLong.status === 422 && payments.length > 0 && payments.every((f) => f.category === "payment"),
      detail: `“refund” → ${refund.length} · nothing → ${none.data?.length} · 61 letters → ${tooLong.status} “${tooLong.message}” · Payments → ${payments.length}`,
    };
  });
  await s.run("13-05", "Opening an FAQ is counted", "Tap a question", async () => {
    const faq = ((await me.call("GET", "/support/faqs?limit=1")).data || [])[0];
    const before = (await database.collection("faqs").findOne({ _id: new mongoose.Types.ObjectId(faq.faqId) })).views || 0;
    const res = await me.call("POST", `/support/faqs/${faq.faqId}/view`);
    const after = (await database.collection("faqs").findOne({ _id: new mongoose.Types.ObjectId(faq.faqId) })).views || 0;
    const unknown = await me.call("POST", "/support/faqs/6a0000000000000000000000/view");
    return { ok: res.status === 200 && after === before + 1 && unknown.status === 404, detail: `views ${before} → ${after} · unknown ${unknown.status}` };
  });

  // ---- Report an issue (ticket)
  const myOrder = (((await me.call("GET", "/orders?status=past&limit=5")).data || {}).items || [])[0];
  const otherOrder = (((await other.call("GET", "/orders?status=past&limit=5")).data || {}).items || [])[0];
  let ticket = null;
  await s.run("13-06", "Report an issue about an order: ticket number, status, reply time", "Report an Issue (with the delivery details attached)", async () => {
    const body = { category: "order", issueType: "Missing item", orderId: myOrder?.orderId, description: "The raita was missing from my order." };
    const res = await me.call("POST", "/support/tickets", body);
    ticket = res.data;
    return {
      ok: res.status === 201 && /^T-\d+$/.test(ticket?.number || "") && ticket.statusLabel === "Open" && ticket.orderNumber === myOrder.orderNumber && /^We'll reply within /.test(ticket.replyByLabel || "") && ticket.categoryName === "My Order",
      detail: `${ticket?.number} · ${ticket?.statusLabel} · ${ticket?.categoryName} / ${ticket?.issueType} · order ${ticket?.orderNumber} · “${ticket?.replyByLabel}”`,
    };
  });
  await s.run("13-07", "Refusals: someone else's order, missing description, unknown category or issue", "Report an Issue errors", async () => {
    const foreign = await me.call("POST", "/support/tickets", { category: "order", orderId: otherOrder?.orderId, description: "Not my order at all." });
    const short = await me.call("POST", "/support/tickets", { category: "order", description: "bad" });
    const category = await me.call("POST", "/support/tickets", { category: "nonsense", description: "Something went wrong here." });
    const issue = await me.call("POST", "/support/tickets", { category: "order", issueType: "Not a real issue", description: "Something went wrong here." });
    return {
      ok: foreign.status === 404 && short.status === 422 && short.message === "Describe the issue (at least 5 characters)" && category.status === 422 && issue.status === 422,
      detail: `other's order ${foreign.status} · short ${short.status} “${short.message}” · category ${category.status} “${category.message}” · issue ${issue.status} “${issue.message}”`,
    };
  });
  await s.run("13-08", "Two taps on Submit make one ticket", "Report an Issue (double tap)", async () => {
    const body = { category: "payment", issueType: "Charged twice", description: "I was charged twice for one order today." };
    const [a, b] = await Promise.all([me.call("POST", "/support/tickets", body), me.call("POST", "/support/tickets", body)]);
    const count = await database.collection("supporttickets").countDocuments({ user: userId, description: body.description });
    return { ok: [a.status, b.status].every((x) => x === 201 || x === 200) && count === 1 && a.data?.ticketId === b.data?.ticketId, detail: `taps ${a.status}/${b.status} · tickets ${count}` };
  });

  // ---- My tickets and the conversation
  await s.run("13-09", "My tickets and one ticket's conversation; other customers cannot see it", "Ticket list / ticket detail", async () => {
    const list = (await me.call("GET", "/support/tickets?limit=10")).data || {};
    const detail = (await me.call("GET", `/support/tickets/${ticket.ticketId}`)).data || {};
    const foreign = await other.call("GET", `/support/tickets/${ticket.ticketId}`);
    const row = (list.items || []).find((t) => t.ticketId === ticket.ticketId);
    return {
      ok: row && row.statusLabel && row.timeLabel && typeof list.hasMore === "boolean" && detail.messages?.length >= 1 && detail.messages[0].body.includes("raita") && detail.messages[0].isMine === true && foreign.status === 404,
      detail: `${list.total} tickets · “${row?.number} ${row?.statusLabel} · ${row?.timeLabel}” · ${detail.messages?.length} message(s) · other customer ${foreign.status}`,
    };
  });
  await s.run("13-10", "Support replies: status moves on, the reply is in the ticket and the inbox", "Ticket update notification", async () => {
    await admin.call("POST", `/admin/support/tickets/${ticket.ticketId}/messages`, { body: "Sorry about that! We've refunded the raita." });
    const detail = (await me.call("GET", `/support/tickets/${ticket.ticketId}`)).data;
    let note = null;
    for (let i = 0; i < 15 && !note; i += 1) {
      await wait(800);
      note = ((await me.call("GET", "/notifications?category=account&limit=10")).data?.items || []).find((n) => n.deepLink?.url?.includes(ticket.ticketId));
    }
    const reply = detail.messages.at(-1);
    return { ok: detail.statusLabel === "In progress" && reply.isMine === false && reply.author.role === "agent" && Boolean(note), detail: `${detail.statusLabel} · “${reply.body}” (${reply.author.name || reply.author.role}) · inbox “${note?.title}: ${note?.body}”` };
  });
  await s.run("13-11", "Customer replies; rating only once the ticket is resolved, and only once", "Reply / rate support", async () => {
    const reply = await me.call("POST", `/support/tickets/${ticket.ticketId}/messages`, { body: "Thank you!" });
    const early = await me.call("POST", `/support/tickets/${ticket.ticketId}/csat`, { rating: 5 });
    await admin.call("PATCH", `/admin/support/tickets/${ticket.ticketId}`, { status: "resolved" });
    const [a, b] = await Promise.all([me.call("POST", `/support/tickets/${ticket.ticketId}/csat`, { rating: 5, comment: "Quick help" }), me.call("POST", `/support/tickets/${ticket.ticketId}/csat`, { rating: 4 })]);
    const after = (await me.call("GET", `/support/tickets/${ticket.ticketId}`)).data;
    const closed = await me.call("POST", `/support/tickets/${ticket.ticketId}/messages`, { body: "One more thing" });
    return {
      ok: reply.status === 201 && early.status === 409 && [a.status, b.status].sort().join() === "200,409" && after.csat?.rating && after.statusLabel === "Closed" && closed.status === 409,
      detail: `reply ${reply.status} · rate early ${early.status} · two ratings ${a.status}/${b.status} → ${after.csat?.rating}★ ${after.statusLabel} · message after close ${closed.status}`,
    };
  });

  // ---- Live chat and the Meal Ji Plus help screen
  await s.run("13-12", "Live chat opens WhatsApp with a reply-time badge", "Start Chat / Chat with us (≈ 2 min)", async () => {
    const chat = (await me.call("POST", "/support/chat/sessions")).data || {};
    return { ok: chat.available === true && /^https:\/\/wa\.me\/91\d{10}\?text=/.test(chat.url || "") && /^≈ \d+ min$/.test(chat.etaLabel || ""), detail: `${chat.provider} · ${chat.etaLabel} · ${chat.url?.slice(0, 40)}…` };
  });
  await s.run("13-13", "Meal Ji Plus Help & Support: options, hours and subscription tickets", "FAQs · Chat with us · Call support · Email support · Report an Issue", async () => {
    const plusConfig = (await me.call("GET", "/support/config?context=subscription")).data || {};
    const options = plusConfig.contactMethods || [];
    const sub = await database.collection("subscriptions").findOne({ user: userId });
    const foreignSub = await database.collection("subscriptions").findOne({ user: { $ne: userId } });
    const own = sub ? await me.call("POST", "/support/tickets", { category: "subscription", issueType: "Meal not delivered", subscriptionId: String(sub._id), description: "Today's lunch did not arrive." }) : null;
    const foreign = foreignSub ? await me.call("POST", "/support/tickets", { category: "subscription", subscriptionId: String(foreignSub._id), description: "Somebody else's plan here." }) : null;
    return {
      ok: options.some((o) => o.key === "faqs") && options.some((o) => o.key === "chat" && o.badge) && options.some((o) => o.key === "call") && options.some((o) => o.key === "email") && (!own || own.status === 201) && (!foreign || foreign.status === 404),
      detail: `${options.map((o) => `${o.title}${o.badge ? ` (${o.badge})` : ""}`).join(" · ")} · own plan ticket ${own?.status ?? "no plan"} · other's plan ${foreign?.status ?? "none"}`,
    };
  });
  await s.run("13-14", "Signed out and staff-only routes are refused", "Security", async () => {
    const anon = await new Client().call("GET", "/support/tickets");
    const queue = await me.call("GET", "/admin/support/tickets");
    return { ok: anon.status === 401 && queue.status === 403, detail: `signed out ${anon.status} · customer → staff queue ${queue.status}` };
  });
  await s.run("13-15", "Ticket attachments must be the customer's own ticket uploads", "Report an Issue → attach a photo", async () => {
    const mine = (await me.call("POST", "/uploads/presign", { purpose: "ticket", contentType: "image/png", size: 2000 })).data || {};
    const theirs = String(mine.fileUrl || "").replace(`ticket/${userId}/`, `ticket/${other.session.user.userId}/`);
    const avatar = (await me.call("POST", "/uploads/presign", { purpose: "avatar", contentType: "image/png", size: 2000 })).data || {};
    const base = { category: "order", issueType: "Missing item", description: "Photo of the missing item attached." };
    const foreign = await me.call("POST", "/support/tickets", { ...base, attachments: [theirs] });
    const wrongPurpose = await me.call("POST", "/support/tickets", { ...base, attachments: [avatar.fileUrl] });
    const outside = await me.call("POST", "/support/tickets", { ...base, attachments: ["https://example.com/x.png"] });
    return { ok: mine.fileUrl?.includes(`ticket/${userId}/`) && foreign.status === 422 && foreign.message === "Attach files you uploaded for this ticket" && wrongPurpose.status === 422 && outside.status === 422, detail: `someone else's file ${foreign.status} “${foreign.message}” · avatar upload ${wrongPurpose.status} · outside link ${outside.status} “${outside.message}”` };
  });
  return s;
}
