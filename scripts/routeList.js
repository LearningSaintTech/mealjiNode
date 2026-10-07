// Lists every mounted Express route ("METHOD /path") and normalises Postman
// URLs the same way, so the checker and the generator agree.

function mountPath(layer) {
  if (layer.path) return layer.path;
  if (!layer.regexp || layer.regexp.fast_slash) return "";
  const source = layer.regexp.source;
  if (source === "^\\/?(?=\\/|$)") return "";

  let routePath = source
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .split("(?:\\/([^/]+?))").join("/:param")
    .split("(?:([^\\/]+?))").join(":param")
    .replace(/\\\//g, "/")
    .replace(/\$$/, "");

  if (!routePath.startsWith("/")) routePath = `/${routePath}`;
  return routePath;
}

function joinPaths(prefix, routePath) {
  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const right = routePath === "/" ? "" : routePath;
  const joined = `${left}${right.startsWith("/") || right === "" ? right : `/${right}`}`;
  if (!joined || joined === "") return "/";
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

export function collectRoutes(stack, prefix = "") {
  const routes = [];
  for (const layer of stack || []) {
    if (layer.route) {
      const routePath = joinPaths(prefix, layer.route.path);
      for (const method of Object.keys(layer.route.methods)) {
        if (method === "head" || method === "_all" || !layer.route.methods[method]) continue;
        routes.push({ method: method.toUpperCase(), path: routePath });
      }
    } else if (layer.name === "router" && layer.handle?.stack) {
      routes.push(...collectRoutes(layer.handle.stack, joinPaths(prefix, mountPath(layer))));
    }
  }
  return routes;
}

export function normalizePath(raw) {
  const withoutQuery = String(raw || "").split("?")[0];
  const stripped = withoutQuery.replace(/\{\{baseUrl\}\}/g, "");
  const withSlash = stripped.startsWith("/") ? stripped : `/${stripped}`;
  const collapsed = withSlash.replace(/\/+/g, "/");
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
  return trimmed.replace(/\/:\w+/g, "/:param").replace(/\/\{\{[^}]+\}\}/g, "/:param").replace(/\/\*$/, "/:param");
}

export function collectPostman(items, acc = []) {
  for (const item of items || []) {
    if (item.item) {
      collectPostman(item.item, acc);
      continue;
    }
    if (!item.request) continue;
    const method = String(item.request.method || "").toUpperCase();
    const raw = typeof item.request.url === "string" ? item.request.url : item.request.url?.raw;
    acc.push(`${method} ${normalizePath(raw)}`);
  }
  return acc;
}

export async function mountedRoutes() {
  process.env.LOG_PRETTY = "false";
  const { app } = await import("../src/app.js");
  const seen = new Map();
  for (const route of collectRoutes(app._router.stack)) {
    const key = `${route.method} ${normalizePath(route.path)}`;
    if (!seen.has(key)) seen.set(key, route);
  }
  return seen;
}
