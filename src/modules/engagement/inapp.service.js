import mongoose from "mongoose";
import { isSafeLink } from "../../common/links.js";
import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";
import { segmentIdsForUser } from "./segment.service.js";

const { ObjectId } = mongoose.Schema.Types;

// Banners, modals and bottom sheets the app shows on a screen, targeted by segment.
const inAppSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    screen: { type: String, required: true, maxlength: 40 }, // home, menu, cart, orders, plus, any
    type: { type: String, enum: ["modal", "banner", "bottom_sheet"], default: "modal" },
    title: { type: String, required: true, maxlength: 80 },
    body: { type: String, default: "", maxlength: 300 },
    imageUrl: { type: String, default: null },
    ctaLabel: { type: String, default: null, maxlength: 30 },
    deepLink: { type: String, default: null },
    segment: { type: ObjectId, ref: "Segment", default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    priority: { type: Number, default: 0 },
    maxImpressionsPerUser: { type: Number, default: 1 },
    status: { type: String, enum: ["draft", "active", "paused"], default: "draft" },
    stats: { impressions: { type: Number, default: 0 }, clicks: { type: Number, default: 0 }, dismissals: { type: Number, default: 0 } },
  },
  { timestamps: true },
);
export const InAppMessage = mongoose.model("InAppMessage", inAppSchema);

const impressionSchema = new mongoose.Schema({ message: { type: ObjectId, required: true }, user: { type: ObjectId, required: true }, shown: { type: Number, default: 0 }, clicked: { type: Boolean, default: false }, dismissed: { type: Boolean, default: false } }, { timestamps: true });
impressionSchema.index({ message: 1, user: 1 }, { unique: true });
export const InAppImpression = mongoose.model("InAppImpression", impressionSchema);

export function toInApp(message) {
  return {
    inAppId: String(message._id),
    name: message.name,
    screen: message.screen,
    type: message.type,
    title: message.title,
    body: message.body,
    imageUrl: message.imageUrl,
    ctaLabel: message.ctaLabel,
    deepLink: message.deepLink,
    segmentId: message.segment ? String(message.segment) : null,
    startsAt: message.startsAt,
    endsAt: message.endsAt,
    priority: message.priority,
    maxImpressionsPerUser: message.maxImpressionsPerUser,
    status: message.status,
    stats: message.stats,
  };
}

export async function saveInApp(id, input) {
  const data = {};
  for (const key of ["name", "screen", "type", "title", "body", "ctaLabel", "priority", "maxImpressionsPerUser", "status"]) if (input[key] !== undefined) data[key] = input[key];
  if (input.deepLink !== undefined) {
    if (!isSafeLink(input.deepLink)) throw new AppError(422, "Validation failed", [{ field: "deepLink", message: "Link must start with mealji:// or https://" }]);
    data.deepLink = input.deepLink ? String(input.deepLink).trim() : null;
  }
  if (input.imageUrl !== undefined) data.imageUrl = assertOwnFileUrl(input.imageUrl);
  if (input.segmentId !== undefined) data.segment = input.segmentId ? objectId(input.segmentId, "segment ID") : null;
  for (const key of ["startsAt", "endsAt"]) if (input[key] !== undefined) data[key] = input[key] ? new Date(input[key]) : null;
  if (!id && (!data.name || !data.title || !data.screen)) throw new AppError(422, "Name, screen and title are required");
  const message = id ? await InAppMessage.findByIdAndUpdate(objectId(id, "message ID"), { $set: data }, { new: true }) : await InAppMessage.create(data);
  if (!message) throw new AppError(404, "Message not found");
  return toInApp(message);
}

/** Messages to show on a screen now (segment, schedule and frequency applied). */
export async function forScreen(userId, screen) {
  const now = new Date();
  const messages = await InAppMessage.find({
    status: "active",
    screen: { $in: [screen, "any"] },
    $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
  }).sort({ priority: -1 }).limit(20).lean();
  if (!messages.length) return [];
  const segments = await segmentIdsForUser(userId);
  const seen = new Map((await InAppImpression.find({ user: userId, message: { $in: messages.map((item) => item._id) } }).lean()).map((row) => [String(row.message), row]));
  return messages
    .filter((message) => !message.segment || segments.includes(String(message.segment)))
    .filter((message) => {
      const row = seen.get(String(message._id));
      return !row || (!row.dismissed && !row.clicked && row.shown < (message.maxImpressionsPerUser || 1));
    })
    .slice(0, 3)
    .map(toInApp);
}

export async function track(userId, id, event) {
  const message = objectId(id, "message ID");
  if (!(await InAppMessage.exists({ _id: message }))) throw new AppError(404, "Message not found");
  const update = event === "shown" ? { $inc: { shown: 1 } } : { $set: { [event === "clicked" ? "clicked" : "dismissed"]: true } };
  await InAppImpression.updateOne({ message, user: userId }, update, { upsert: true });
  await InAppMessage.updateOne({ _id: message }, { $inc: { [`stats.${event === "shown" ? "impressions" : event === "clicked" ? "clicks" : "dismissals"}`]: 1 } });
  return { tracked: true };
}
