import mongoose from "mongoose";

// Every domain event is first written here, in the same transaction as the
// business change. The relay then hands it to the queue, so an event is never
// lost when a process dies between "saved" and "published".
const outboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    aggregate: {
      type: { type: String, default: null },
      id: { type: String, default: null },
    },
    actor: {
      userId: { type: String, default: null },
      role: { type: String, default: null },
    },
    status: { type: String, enum: ["pending", "dispatching", "dispatched", "failed"], default: "pending" },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    occurredAt: { type: Date, default: Date.now },
    dispatchedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

outboxSchema.index({ status: 1, occurredAt: 1 });
// Dispatched events are kept two weeks for debugging, then removed.
outboxSchema.index({ dispatchedAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600, partialFilterExpression: { status: "dispatched" } });

export const OutboxEvent = mongoose.model("OutboxEvent", outboxSchema);

// Remembers which handler already processed which event, so at-least-once
// delivery never runs a side effect twice.
const processedSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    handler: { type: String, required: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

processedSchema.index({ eventId: 1, handler: 1 }, { unique: true });
processedSchema.index({ processedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const ProcessedEvent = mongoose.model("ProcessedEvent", processedSchema);
