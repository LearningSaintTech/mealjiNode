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

export async function outboxBacklog() {
  const [pending, failed] = await Promise.all([
    OutboxEvent.countDocuments({ status: { $in: ["pending", "dispatching"] } }),
    OutboxEvent.countDocuments({ status: "failed" }),
  ]);
  return { pending, failed };
}
