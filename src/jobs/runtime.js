import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { dispatchEvent } from "../events/eventBus.js";
import { registerEventHandlers } from "../events/handlers.js";
import { startHub } from "../realtime/hub.js";
import { markOutboxFailed, relayOutbox } from "../events/relay.js";
import { closeQueues, connectQueues, getQueue, markWorkersRunning, QUEUES, startWorker } from "./queue.js";
import { runTask, SCHEDULED_TASKS } from "./tasks.js";

const timers = [];
let running = false;

function every(ms, fn, label) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      logger.warn({ err: err.message, task: label }, "Background task failed");
    } finally {
      busy = false;
    }
  }, ms);
  timer.unref?.();
  timers.push(timer);
}

async function registerSchedules() {
  const queue = getQueue(QUEUES.scheduled);
  for (const task of SCHEDULED_TASKS) {
    const repeat = task.pattern ? { pattern: task.pattern, tz: "Asia/Kolkata" } : { every: task.every };
    await queue.upsertJobScheduler(task.name, repeat, { name: task.name, data: {} });
  }
}

/**
 * Starts background processing in this process: the outbox relay, the domain
 * event workers and the scheduled tasks. With Redis queues this uses BullMQ
 * (retries, one runner per scheduled job across processes). Without Redis in
 * development it falls back to simple in-process timers.
 */
export async function startBackground({ role = "worker" } = {}) {
  if (running) return;
  running = true;
  await registerEventHandlers();
  await startHub();

  every(env.outboxRelayIntervalMs, relayOutbox, "outbox-relay");

  const queues = await connectQueues();
  if (queues) {
    const events = startWorker(QUEUES.domainEvents, (job) => dispatchEvent(job.data), { concurrency: 10 });
    events.on("failed", (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
        markOutboxFailed(job.data.eventId, err?.message).catch(() => {});
      }
    });
    startWorker(QUEUES.scheduled, (job) => runTask(job.name), { concurrency: 2 });
    await registerSchedules();
    markWorkersRunning(true);
    logger.info({ role, tasks: SCHEDULED_TASKS.map((task) => task.name) }, "Background workers started (queues)");
  } else {
    for (const task of SCHEDULED_TASKS) {
      // Without BullMQ there is no cron: interval tasks keep their interval and
      // daily cron tasks run once a day from start-up (development only).
      every(task.every || 24 * 3600_000, () => runTask(task.name), task.name);
    }
    logger.info({ role }, "Background work running in-process (no queues)");
  }
}

export async function stopBackground() {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  await closeQueues();
  running = false;
}
