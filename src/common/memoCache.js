// Tiny in-process cache for hot, rarely-changing data (roles, active kitchens,
// app config). Entries live a few seconds; concurrent callers share one load.
// Each API process has its own copy: clearing one (on a write) is broadcast
// through Redis so the other processes drop it too (no 5–30 s of stale data,
// e.g. a paused kitchen still taking orders in another process).
import { onMessage, publish } from "../realtime/hub.js";

const ROOM = "__cache__";
const registry = new Map();
const origin = `${process.pid}:${Math.random().toString(36).slice(2)}`;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  onMessage((message) => {
    if (message?.room !== ROOM || message.data?.origin === origin) return;
    registry.get(message.data.name)?.clearLocal(message.data.key ?? undefined);
  });
}

export function memoCache(ttlMs, name = null) {
  const entries = new Map();
  const clearLocal = (key) => {
    if (key === undefined) entries.clear();
    else entries.delete(key);
  };
  if (name) {
    registry.set(name, { clearLocal });
    listen();
  }
  return {
    async get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      if (hit?.pending) return hit.pending;
      const pending = load().then((value) => {
        entries.set(key, { value, expires: Date.now() + ttlMs });
        return value;
      }, (err) => {
        entries.delete(key);
        throw err;
      });
      entries.set(key, { pending, expires: 0 });
      return pending;
    },
    clear(key) {
      clearLocal(key);
      if (name) publish(ROOM, "cache:clear", { name, key: key === undefined ? null : String(key), origin });
    },
  };
}
