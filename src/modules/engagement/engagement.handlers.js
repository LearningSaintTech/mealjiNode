import { storeSetNx } from "../../infrastructure/redisStore.js";

// Events that change a customer's traits (recomputed at most once a minute per person).
const TRAIT_EVENTS = ["order.", "subscription.", "cart.updated", "user.", "reward.", "favorite."];

async function throttled(key, seconds) {
  try {
    return await storeSetNx(key, "1", seconds);
  } catch {
    return true;
  }
}

export function registerHandlers(subscribe) {
  subscribe("*", "engagement.traits", async (event) => {
    const userId = event.payload?.userId;
    if (!userId || !TRAIT_EVENTS.some((prefix) => event.name.startsWith(prefix))) return;
    if (!(await throttled(`traits:recompute:${userId}`, 60))) return;
    const { computeTraits } = await import("./traits.service.js");
    await computeTraits(userId);
  });
  subscribe("*", "engagement.journeys", async (event) => {
    if (!event.payload?.userId || event.name.startsWith("notification.") || event.name.startsWith("settings.")) return;
    const { onEvent } = await import("./journey.service.js");
    await onEvent(event);
  });
  subscribe("order.placed", "engagement.attribution", async (event) => {
    const { attributeConversion } = await import("./campaign.service.js");
    await attributeConversion({ userId: event.payload.userId, orderId: event.payload.orderId, valuePaise: event.payload.totalPaise });
  });
}
