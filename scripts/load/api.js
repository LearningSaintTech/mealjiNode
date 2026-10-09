// The API on the load database (port 4100 by default): npm run load:api
// LOAD_PROFILE_SEC=40 records a CPU profile for that many seconds after start
// and writes test-reports/load-cpu.cpuprofile (open it in Chrome DevTools, or
// run: node scripts/load/profileTop.js).
import "./loadEnv.js";

// --opcount: counts MongoDB operations per endpoint (writes test-reports/load-ops.json every 10 s).
if (process.argv.includes("--opcount")) {
  const http = await import("node:http");
  const fs = await import("node:fs");
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const mongoose = (await import("mongoose")).default;
  const als = new AsyncLocalStorage();
  const counts = {};
  const original = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(event, req, ...rest) {
    if (event !== "request") return original.call(this, event, req, ...rest);
    const route = `${req.method} ${req.url.split("?")[0].replace(/[0-9a-f]{24}/g, ":id")}`;
    counts[route] ||= { requests: 0, ops: {} };
    counts[route].requests += 1;
    return als.run(route, () => original.call(this, event, req, ...rest));
  };
  mongoose.set("debug", (collection, method) => {
    const route = als.getStore();
    if (!route) return;
    const key = `${collection}.${method}`;
    counts[route].ops[key] = (counts[route].ops[key] || 0) + 1;
  });
  // Redis commands too (same per-endpoint table, prefixed "redis.").
  const { redis } = await import("../../src/config/redis.js");
  const send = redis.sendCommand.bind(redis);
  redis.sendCommand = (command, ...rest) => {
    const route = als.getStore();
    if (route) {
      const key = `redis.${command.name}`;
      counts[route].ops[key] = (counts[route].ops[key] || 0) + 1;
    }
    return send(command, ...rest);
  };
  setInterval(() => {
    const rows = Object.entries(counts).map(([route, c]) => ({ route, requests: c.requests, opsPerRequest: Math.round((Object.values(c.ops).reduce((a, b) => a + b, 0) / c.requests) * 10) / 10, ops: Object.fromEntries(Object.entries(c.ops).map(([k, v]) => [k, Math.round((v / c.requests) * 10) / 10])) }));
    rows.sort((a, b) => b.opsPerRequest - a.opsPerRequest);
    fs.mkdirSync("test-reports", { recursive: true });
    fs.writeFileSync("test-reports/load-ops.json", JSON.stringify(rows, null, 2));
  }, 10_000).unref();
}

await import("../../src/server.js");

const seconds = Number(process.env.LOAD_PROFILE_SEC || process.argv.find((item) => item.startsWith("--profile="))?.split("=")[1] || 0);
if (seconds > 0) {
  const fs = await import("node:fs");
  const inspector = await import("node:inspector/promises");
  const session = new inspector.Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 500 });
  await session.post("Profiler.start");
  console.log(`CPU profile recording for ${seconds} s`);
  setTimeout(async () => {
    const { profile } = await session.post("Profiler.stop");
    fs.mkdirSync("test-reports", { recursive: true });
    fs.writeFileSync("test-reports/load-cpu.cpuprofile", JSON.stringify(profile));
    console.log("CPU profile written: test-reports/load-cpu.cpuprofile");
  }, seconds * 1000);
}
