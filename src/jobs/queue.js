import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

// BullMQ needs its own Redis connection: it does not allow ioredis `keyPrefix`
// and requires `maxRetriesPerRequest: null`. Keys are namespaced with `prefix`.
const PREFIX = `${env.redisKeyPrefix}bull`;

export const QUEUES = {
  domainEvents: "domain-events",
  scheduled: "scheduled",
};

let connection = null;
const queues = new Map();
const workers = [];
let workersRunning = false;

// True only when this process started queue workers. The outbox relay hands
// events to the queue only then; otherwise it runs handlers in-process, so an
// event is never queued with nobody to consume it.
export function markWorkersRunning(value) {
  workersRunning = value;
}

export function workersActive() {
  return workersRunning && connection?.status === "ready";
}

function getConnection() {
  if (!connection) {
    connection = new Redis({
      host: env.redisHost,
      port: env.redisPort,
      password: env.redisPassword || undefined,
      tls: env.redisTls ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    connection.on("error", (err) => logger.warn({ err: err.message }, "Queue Redis error"));
  }
  return connection;
}

// Connects the queue Redis. Returns false (development) when Redis is down, so
// the caller can fall back to running work in-process.
export async function connectQueues() {
  const conn = getConnection();
  if (conn.status === "ready") return true;
  try {
    if (conn.status === "wait") await conn.connect();
    await conn.ping();
    return true;
  } catch (err) {
    if (env.isProd) throw err;
    logger.warn({ err: err.message }, "Queues unavailable, background work runs in-process");
    return false;
  }
}

export function queuesReady() {
  return connection?.status === "ready";
}

export function getQueue(name) {
  if (!queues.has(name)) {
    queues.set(name, new Queue(name, {
      connection: getConnection(),
      prefix: PREFIX,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }));
  }
  return queues.get(name);
}

export function startWorker(name, processor, { concurrency = 5 } = {}) {
  const worker = new Worker(name, processor, { connection: getConnection(), prefix: PREFIX, concurrency });
  worker.on("failed", (job, err) => {
    logger.warn({ queue: name, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "Job failed");
  });
  worker.on("error", (err) => logger.error({ queue: name, err: err.message }, "Worker error"));
  workers.push(worker);
  return worker;
}

export async function closeQueues() {
  workersRunning = false;
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
  if (connection) connection.disconnect();
}
