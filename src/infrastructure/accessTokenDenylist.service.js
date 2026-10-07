import { storeGet, storeSet } from "./redisStore.js";

// Signing a user out everywhere uses User.sessionsRevokedAt instead of tracking
// every token id.

export async function denyAccessJti({ jti, exp }) {
  const ttl = Math.max(Number(exp) - Math.floor(Date.now() / 1000), 1);
  await storeSet(`deny:access:${jti}`, "1", ttl);
}

export async function isAccessDenied(jti) {
  if (!jti) return false;
  const value = await storeGet(`deny:access:${jti}`, { failClosed: true });
  return value === "1";
}
