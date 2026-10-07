import mongoose from "mongoose";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { logger } from "../../config/logger.js";
import { notify } from "../notification/notification.service.js";

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * A journey: trigger (a domain event) → steps.
 * Step types:
 *   { type: "wait", minutes }
 *   { type: "send", templateKey, channels?, category? }
 *   { type: "condition", check: "no_order_since_enroll" | "no_order_days" | "not_plus", days?, elseExit: true }
 * `exitOn` events end an enrollment early (e.g. order.placed for abandoned cart).
 */
const journeySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "" },
    trigger: { event: { type: String, required: true }, filter: { type: Mixed, default: {} } },
    steps: { type: [Mixed], default: [] },
    exitOn: { type: [String], default: [] },
    reentryDays: { type: Number, default: 0 }, // 0 = once per person ever
    status: { type: String, enum: ["active", "inactive"], default: "inactive" },
    stats: { entered: { type: Number, default: 0 }, completed: { type: Number, default: 0 }, exited: { type: Number, default: 0 } },
  },
  { timestamps: true, minimize: false },
);
export const Journey = mongoose.model("Journey", journeySchema);

const enrollmentSchema = new mongoose.Schema(
  {
    journey: { type: ObjectId, ref: "Journey", required: true },
    user: { type: ObjectId, ref: "User", required: true },
    stepIndex: { type: Number, default: 0 },
    nextRunAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["active", "completed", "exited"], default: "active" },
    context: { type: Mixed, default: {} },
    exitReason: { type: String, default: null },
  },
  { timestamps: true },
);
enrollmentSchema.index({ status: 1, nextRunAt: 1 });
enrollmentSchema.index({ journey: 1, user: 1, createdAt: -1 });
export const JourneyEnrollment = mongoose.model("JourneyEnrollment", enrollmentSchema);

// The journeys from the architecture, shipped switched off so marketing can review copy first.
export const DEFAULT_JOURNEYS = [
  { key: "welcome", name: "Welcome", trigger: { event: "user.first_login", filter: { role: "user" } }, steps: [{ type: "send", templateKey: "journey.welcome", channels: ["inapp", "push"] }, { type: "wait", minutes: 1440 }, { type: "condition", check: "no_order_since_enroll" }, { type: "send", templateKey: "journey.first_order_offer", channels: ["push", "whatsapp"] }], exitOn: ["order.placed"] },
  { key: "abandoned_cart", name: "Abandoned cart", trigger: { event: "cart.updated", filter: { minItems: 1 } }, steps: [{ type: "wait", minutes: 45 }, { type: "condition", check: "cart_not_empty" }, { type: "send", templateKey: "journey.cart_waiting", channels: ["push"] }, { type: "wait", minutes: 1440 }, { type: "condition", check: "cart_not_empty" }, { type: "send", templateKey: "journey.cart_offer", channels: ["whatsapp", "push"] }], exitOn: ["order.placed"], reentryDays: 3 },
  { key: "post_delivery_feedback", name: "Rate your meal", trigger: { event: "order.delivered" }, steps: [{ type: "wait", minutes: 60 }, { type: "condition", check: "order_not_rated" }, { type: "send", templateKey: "journey.rate_meal", channels: ["push", "inapp"] }], exitOn: ["order.rated"], reentryDays: 1 },
  { key: "plus_upsell", name: "MealJi Plus upsell", trigger: { event: "order.delivered" }, steps: [{ type: "condition", check: "frequent_non_plus" }, { type: "send", templateKey: "journey.plus_upsell", channels: ["inapp", "push"] }], exitOn: ["subscription.activated"], reentryDays: 30 },
  { key: "cancellation_save", name: "Cancellation save", trigger: { event: "subscription.cancel_scheduled" }, steps: [{ type: "wait", minutes: 60 }, { type: "send", templateKey: "journey.pause_instead", channels: ["push", "inapp"] }], exitOn: ["subscription.cancel_undone"], reentryDays: 30 },
  { key: "win_back", name: "Win-back (21 days)", trigger: { event: "traits.inactive_21d" }, steps: [{ type: "send", templateKey: "journey.win_back", channels: ["push", "whatsapp"] }], exitOn: ["order.placed"], reentryDays: 30 },
];

export async function ensureDefaultJourneys() {
  for (const journey of DEFAULT_JOURNEYS) {
    await Journey.updateOne({ key: journey.key }, { $setOnInsert: { ...journey, status: "inactive" } }, { upsert: true });
  }
}

export function toJourney(journey) {
  return {
    journeyId: String(journey._id),
    key: journey.key,
    name: journey.name,
    description: journey.description,
    trigger: journey.trigger,
    steps: journey.steps,
    exitOn: journey.exitOn,
    reentryDays: journey.reentryDays,
    status: journey.status,
    stats: journey.stats,
    updatedAt: journey.updatedAt,
  };
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new AppError(422, "A journey has 1 to 20 steps");
  steps.forEach((step, index) => {
    if (step.type === "wait" && !(Number.isInteger(step.minutes) && step.minutes > 0 && step.minutes <= 60 * 24 * 30)) throw new AppError(422, `Step ${index + 1}: wait 1 minute to 30 days`);
    if (step.type === "send" && !step.templateKey) throw new AppError(422, `Step ${index + 1}: choose a template`);
    if (!["wait", "send", "condition"].includes(step.type)) throw new AppError(422, `Step ${index + 1}: unknown type`);
  });
}

export async function saveJourney(journeyId, input) {
  const data = {};
  for (const key of ["name", "description", "trigger", "steps", "exitOn", "reentryDays"]) if (input[key] !== undefined) data[key] = input[key];
  if (data.steps) validateSteps(data.steps);
  if (!journeyId) {
    if (!input.key || !data.name || !data.trigger?.event || !data.steps) throw new AppError(422, "Key, name, trigger and steps are required");
    return toJourney(await Journey.create({ ...data, key: input.key }));
  }
  const journey = await Journey.findByIdAndUpdate(objectId(journeyId, "journey ID"), { $set: data }, { new: true });
  if (!journey) throw new AppError(404, "Journey not found");
  return toJourney(journey);
}

export async function setJourneyStatus(journeyId, status) {
  const journey = await Journey.findByIdAndUpdate(objectId(journeyId, "journey ID"), { $set: { status } }, { new: true });
  if (!journey) throw new AppError(404, "Journey not found");
  if (status === "inactive") await JourneyEnrollment.updateMany({ journey: journey._id, status: "active" }, { $set: { status: "exited", exitReason: "journey_stopped" } });
  return toJourney(journey);
}

export async function listJourneys() {
  await ensureDefaultJourneys();
  return (await Journey.find().sort({ name: 1 }).lean()).map(toJourney);
}

// ------------------------------------------------------------------ runtime

function matchesFilter(filter = {}, payload = {}) {
  if (filter.role && payload.role && filter.role !== payload.role) return false;
  if (filter.minItems && (payload.itemCount || 0) < filter.minItems) return false;
  return true;
}

/** Enrolls the event's user into active journeys triggered by this event. */
export async function onEvent(event) {
  const userId = event.payload?.userId;
  if (!userId) return;
  // Exits first.
  const exiting = await Journey.find({ exitOn: event.name }).select("_id").lean();
  if (exiting.length) {
    const result = await JourneyEnrollment.updateMany({ journey: { $in: exiting.map((row) => row._id) }, user: userId, status: "active" }, { $set: { status: "exited", exitReason: event.name } });
    if (result.modifiedCount) await Journey.updateMany({ _id: { $in: exiting.map((row) => row._id) } }, { $inc: { "stats.exited": result.modifiedCount } });
  }
  const journeys = await Journey.find({ status: "active", "trigger.event": event.name }).lean();
  for (const journey of journeys) {
    if (!matchesFilter(journey.trigger.filter, event.payload)) continue;
    const last = await JourneyEnrollment.findOne({ journey: journey._id, user: userId }).sort({ createdAt: -1 }).lean();
    if (last?.status === "active") continue;
    if (last && (!journey.reentryDays || Date.now() - new Date(last.createdAt) < journey.reentryDays * 86_400_000)) continue;
    await JourneyEnrollment.create({ journey: journey._id, user: userId, context: { ...event.payload, enrolledAt: new Date(), eventId: event.eventId } });
    await Journey.updateOne({ _id: journey._id }, { $inc: { "stats.entered": 1 } });
  }
}

async function conditionHolds(step, enrollment) {
  const userId = enrollment.user;
  const { Order } = await import("../order/order.model.js");
  switch (step.check) {
    case "no_order_since_enroll":
      return !(await Order.exists({ user: userId, createdAt: { $gte: enrollment.createdAt }, status: { $nin: ["payment_failed", "cancelled"] } }));
    case "no_order_days":
      return !(await Order.exists({ user: userId, createdAt: { $gte: new Date(Date.now() - (step.days || 7) * 86_400_000) } }));
    case "cart_not_empty": {
      const { Cart } = await import("../cart/cart.model.js");
      const cart = await Cart.findOne({ user: userId }).select("items").lean();
      return Boolean(cart?.items?.length);
    }
    case "order_not_rated": {
      const order = enrollment.context?.orderId ? await Order.findById(enrollment.context.orderId).select("rating").lean() : null;
      return Boolean(order && !order.rating?.at);
    }
    case "frequent_non_plus": {
      const { User } = await import("../user/user.model.js");
      const user = await User.findById(userId).select("subscription").lean();
      if (user?.subscription?.status === "active") return false;
      return (await Order.countDocuments({ user: userId, status: "delivered", createdAt: { $gte: new Date(Date.now() - 14 * 86_400_000) } })) >= 3;
    }
    case "not_plus": {
      const { User } = await import("../user/user.model.js");
      return (await User.findById(userId).select("subscription").lean())?.subscription?.status !== "active";
    }
    default:
      return true;
  }
}

/** Every minute: advance enrollments whose wait is over. */
export async function runDueEnrollments() {
  const due = await JourneyEnrollment.find({ status: "active", nextRunAt: { $lte: new Date() } }).limit(500);
  for (const enrollment of due) {
    const journey = await Journey.findById(enrollment.journey).lean();
    if (!journey || journey.status !== "active") {
      enrollment.status = "exited";
      enrollment.exitReason = "journey_stopped";
      await enrollment.save();
      continue;
    }
    try {
      let advanced = true;
      while (advanced && enrollment.status === "active") {
        const step = journey.steps[enrollment.stepIndex];
        if (!step) {
          enrollment.status = "completed";
          await Journey.updateOne({ _id: journey._id }, { $inc: { "stats.completed": 1 } });
          break;
        }
        if (step.type === "wait") {
          if (!enrollment.context.waitStartedFor || enrollment.context.waitStartedFor !== enrollment.stepIndex) {
            enrollment.context = { ...enrollment.context, waitStartedFor: enrollment.stepIndex };
            enrollment.markModified("context");
            enrollment.nextRunAt = new Date(Date.now() + step.minutes * 60_000);
            advanced = false;
          } else {
            enrollment.stepIndex += 1;
          }
        } else if (step.type === "condition") {
          if (await conditionHolds(step, enrollment)) enrollment.stepIndex += 1;
          else {
            enrollment.status = "exited";
            enrollment.exitReason = `condition:${step.check}`;
            await Journey.updateOne({ _id: journey._id }, { $inc: { "stats.exited": 1 } });
          }
        } else if (step.type === "send") {
          await notify({
            userId: enrollment.user,
            templateKey: step.templateKey,
            data: enrollment.context,
            channels: step.channels || null,
            category: step.category || "marketing",
            journey: journey._id,
            dedupeKey: `journey:${enrollment._id}:step:${enrollment.stepIndex}`,
          });
          enrollment.stepIndex += 1;
        }
      }
      await enrollment.save();
    } catch (err) {
      logger.warn({ err: err.message, enrollmentId: String(enrollment._id) }, "Journey step failed");
      enrollment.nextRunAt = new Date(Date.now() + 10 * 60_000);
      await enrollment.save();
    }
  }
  return due.length;
}

export async function journeyStats(journeyId) {
  const id = objectId(journeyId, "journey ID");
  const rows = await JourneyEnrollment.aggregate([{ $match: { journey: id } }, { $group: { _id: { status: "$status", step: "$stepIndex" }, total: { $sum: 1 } } }]);
  const { MessageLog } = await import("../notification/notification.model.js");
  const [messages] = await MessageLog.aggregate([{ $match: { journey: id } }, { $group: { _id: null, sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "opened", "clicked"]] }, 1, 0] } }, converted: { $sum: { $cond: ["$convertedAt", 1, 0] } }, revenuePaise: { $sum: "$conversionValuePaise" } } }]);
  return { enrollments: rows.map((row) => ({ status: row._id.status, step: row._id.step, total: row.total })), messages: messages || { sent: 0, converted: 0, revenuePaise: 0 } };
}
