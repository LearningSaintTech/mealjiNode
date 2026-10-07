import client from "prom-client";
import { env } from "../config/env.js";
import { timingSafeEqualString } from "./timingSafe.js";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "mealji_" });

const httpDuration = new client.Histogram({
  name: "mealji_http_request_duration_seconds",
  help: "HTTP request duration by route and status",
  labelNames: ["method", "route", "status"],
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// Labels use the matched route pattern (/users/:userId), never the raw URL, so
// IDs do not explode the metric cardinality.
export function metricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path ? `${res.locals.mountPath || ""}${req.route.path}` : "unmatched";
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

// Mounted in front of each router. Express resets req.baseUrl before the error
// handler runs, so the mount path is recorded here while it is still known.
export function recordMountPath(req, res, next) {
  res.locals.mountPath = req.baseUrl;
  next();
}

// Prometheus scrape endpoint. Requires `Authorization: Bearer <METRICS_TOKEN>`
// when a token is set; disabled in production without one.
export async function metricsHandler(req, res) {
  if (env.metricsToken) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !timingSafeEqualString(token, env.metricsToken)) {
      return res.status(401).json({ success: false, message: "Unauthorized", errors: null });
    }
  } else if (env.isProd) {
    return res.status(404).json({ success: false, message: "Route not found", errors: null });
  }
  res.setHeader("Content-Type", registry.contentType);
  res.end(await registry.metrics());
}
