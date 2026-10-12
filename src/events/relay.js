import { logger } from "../config/logger.js";
import { getQueue, QUEUES, workersActive } from "../jobs/queue.js";
import { dispatchEvent } from "./eventBus.js";
import { OutboxEvent } from "./outbox.model.js";

const BATCH = 100;
const LOCK_MS = 30_000;
const MAX_INLINE_ATTEMPTS = 10;

function toMessage(doc) {
  return {
    eventId: doc.eventId,
    name: doc.name,
    payload: doc.payload,
    aggregate: doc.aggregate,
    actor: doc.actor,
    occurredAt: doc.occurredAt,
  };
}

// Claims one event so several relays (api + worker processes) never hand the
// same event over twice.
async function claimNext(now) {
  return OutboxEvent.findOneAndUpdate(
    {
      $or: [
        { status: "pending", $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
        { status: "dispatching", lockedUntil: { $lte: now } },
      ],
    },
    { $set: { status: "dispatching", lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { occurredAt: 1 }, new: true },
  ).lean();
}

/**
 * Moves pending outbox events onward. With Redis queues available the event is
 * enqueued (job id = event id, so a re-enqueue is ignored) and workers run the
 * handlers with retries. Without queues (local development) handlers run here.
 */
export async function relayOutbox() {
  let handled = 0;
  const useQueue = workersActive();
  for (let i = 0; i < BATCH; i += 1) {
    const now = new Date();
    const doc = await claimNext(now);
    if (!doc) break;
    try {
      if (useQueue) {
        await getQueue(QUEUES.domainEvents).add(doc.name, toMessage(doc), { jobId: doc.eventId });
      } else {
        await dispatchEvent(toMessage(doc));
      }
      // Conditional on our claim, so a relay whose lock expired cannot overwrite
      // the outcome written by the relay that took over.
      await OutboxEvent.updateOne(
        { _id: doc._id, status: "dispatching", lockedUntil: doc.lockedUntil },
        { $set: { status: "dispatched", dispatchedAt: new Date(), lockedUntil: null, lastError: null } },
      );
      handled += 1;
    } catch (err) {
      const failed = !useQueue && doc.attempts >= MAX_INLINE_ATTEMPTS;
      const retryInMs = Math.min(2 ** doc.attempts * 1000, 5 * 60_000);
      await OutboxEvent.updateOne(
        { _id: doc._id, status: "dispatching", lockedUntil: doc.lockedUntil },
        { $set: { status: failed ? "failed" : "pending", lastError: err.message.slice(0, 500), lockedUntil: new Date(Date.now() + retryInMs) } },
      );
      logger.warn({ err: err.message, event: doc.name, eventId: doc.eventId, attempts: doc.attempts }, "Outbox dispatch failed");
    }
  }
  return handled;
}

// Called when a queued event exhausted all its retries, so the outbox shows it
// as failed (and it can be found and replayed) instead of "dispatched".
export async function markOutboxFailed(eventId, error) {
  await OutboxEvent.updateOne(
    { eventId },
    { $set: { status: "failed", lastError: String(error || "Handler failed").slice(0, 500) } },
  );
}

/** Puts failed events back in the queue (one, or all failed ones). Returns how many. */
export async function replayFailedEvents({ eventId = null } = {}) {
  const filter = { status: "failed", ...(eventId ? { eventId } : {}) };
  const events = await OutboxEvent.find(filter).select("eventId").limit(1000).lean();
  // The queue keeps a failed job (same id) for 7 days and would ignore a new one: remove it first.
  const queue = getQueue(QUEUES.domainEvents);
  for (const { eventId: id } of events) {
    const job = await queue.getJob(id).catch(() => null);
    if (job) await job.remove().catch(() => {});
  }
  const result = await OutboxEvent.updateMany({ _id: { $exists: true }, status: "failed", eventId: { $in: events.map((event) => event.eventId) } }, { $set: { status: "pending", lastError: null, lockedUntil: null } });
  return result.modifiedCount;
}

export async function listFailedEvents({ limit = 50 } = {}) {
  return (await OutboxEvent.find({ status: "failed" }).sort({ occurredAt: -1 }).limit(limit).lean())
    .map((event) => ({ eventId: event.eventId, name: event.name, occurredAt: event.occurredAt, lastError: event.lastError || null, aggregate: event.aggregate || null }));
}

export async function outboxBacklog() {
  const [pending, failed] = await Promise.all([
    OutboxEvent.countDocuments({ status: { $in: ["pending", "dispatching"] } }),
    OutboxEvent.countDocuments({ status: "failed" }),
  ]);
  return { pending, failed };
}
