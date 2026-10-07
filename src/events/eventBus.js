import crypto from "node:crypto";
import { logger } from "../config/logger.js";
import { OutboxEvent, ProcessedEvent } from "./outbox.model.js";

const subscribers = new Map();

/**
 * Records a domain event. Pass the transaction `session` when the event belongs
 * to a business write, so both commit or neither does. Delivery to subscribers
 * happens asynchronously through the outbox relay.
 */
export async function publishEvent(name, payload = {}, { session = null, aggregate = null, actor = null } = {}) {
  const doc = {
    eventId: crypto.randomUUID(),
    name,
    payload,
    aggregate: aggregate ? { type: aggregate.type, id: aggregate.id ? String(aggregate.id) : null } : undefined,
    actor: actor ? { userId: actor.userId ? String(actor.userId) : null, role: actor.role || null } : undefined,
    occurredAt: new Date(),
  };
  await OutboxEvent.create([doc], session ? { session } : {});
  return doc.eventId;
}

// Publishing must never break the business action that triggered it.
export async function publishEventSafe(name, payload, options) {
  try {
    return await publishEvent(name, payload, options);
  } catch (err) {
    logger.error({ err: err.message, event: name }, "Could not record domain event");
    return null;
  }
}

/**
 * Registers a handler. `pattern` is an exact event name, a prefix ending in
 * `.*` (e.g. `order.*`), or `*`. `handlerName` must be unique and stable: it is
 * the key that records a handler as done for an event.
 *
 * Delivery is at-least-once: a handler is marked done only after it succeeds,
 * so a crash mid-handler means it runs again. Handlers must be idempotent
 * (e.g. use the eventId as a dedupe key for anything they create).
 */
export function subscribe(pattern, handlerName, handler) {
  if (!subscribers.has(handlerName)) subscribers.set(handlerName, { pattern, handler });
}

function matches(pattern, name) {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

// Runs every matching handler that has not completed for this event. Throws if
// any handler fails so the queue retries; handlers that already succeeded are
// skipped on the retry.
export async function dispatchEvent(event) {
  const failures = [];
  const matching = [...subscribers].filter(([, { pattern }]) => matches(pattern, event.name));
  if (!matching.length) return;
  const done = new Set(
    (await ProcessedEvent.find({ eventId: event.eventId }).select("handler").lean()).map((row) => row.handler),
  );
  for (const [handlerName, { handler }] of matching) {
    if (done.has(handlerName)) continue;
    try {
      await handler(event);
    } catch (err) {
      logger.error({ err: err.message, event: event.name, eventId: event.eventId, handler: handlerName }, "Event handler failed");
      failures.push(handlerName);
      continue;
    }
    await ProcessedEvent.create({ eventId: event.eventId, handler: handlerName }).catch((err) => {
      if (err?.code !== 11000) throw err;
    });
  }
  if (failures.length) {
    throw new Error(`Handlers failed: ${failures.join(", ")}`);
  }
}

export function registeredHandlers() {
  return [...subscribers.entries()].map(([name, { pattern }]) => ({ name, pattern }));
}
