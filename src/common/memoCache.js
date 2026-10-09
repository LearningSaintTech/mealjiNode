// Tiny in-process cache for hot, rarely-changing data (roles, active kitchens,
// app config). Entries live a few seconds; concurrent callers share one load.
// Each API instance has its own copy, so keep TTLs short and clear on writes.
export function memoCache(ttlMs) {
  const entries = new Map();
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
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
