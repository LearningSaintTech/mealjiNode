// Runs several API processes on one server (one per CPU core by default), all
// sharing the same port. A single Node process uses one core; the load test
// showed one process tops out at roughly 120–150 requests/s on a developer
// laptop, so production runs one API process per core.
//
//   npm run start:cluster              (WEB_CONCURRENCY = number of processes)
//   npm run worker                     (background jobs: run ONE of these separately)
//
// Background jobs never run inside these API processes. Realtime updates fan
// out through Redis, so a WebSocket can be connected to any of them.
import cluster from "node:cluster";
import os from "node:os";

const wanted = Number(process.env.WEB_CONCURRENCY) || os.availableParallelism?.() || os.cpus().length;

if (cluster.isPrimary) {
  console.log(`mealJiNode cluster: starting ${wanted} API processes`);
  let stopping = false;
  for (let i = 0; i < wanted; i += 1) cluster.fork({ RUN_WORKERS_IN_API: "false" });
  cluster.on("exit", (worker, code, signal) => {
    if (stopping) return;
    console.error(`API process ${worker.process.pid} stopped (${signal || code}); starting a new one`);
    setTimeout(() => cluster.fork({ RUN_WORKERS_IN_API: "false" }), 1000);
  });
  const stop = (signal) => {
    stopping = true;
    for (const worker of Object.values(cluster.workers)) worker.process.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
} else {
  await import("./server.js");
}
