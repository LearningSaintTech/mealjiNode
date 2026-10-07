import { logger } from "./config/logger.js";
import { recordMountPath } from "./common/metrics.js";

// Routers of later phases (subscriptions, loyalty, support, engagement,
// experiments). Each module exports `mount(app, recordMountPath)`; they are
// loaded at start-up so the main app file stays readable.
const PHASE_MODULES = [
  "./modules/subscription/subscription.routes.js",
  "./modules/rewards/rewards.routes.js",
  "./modules/support/support.routes.js",
  "./modules/favorites/favorites.routes.js",
  "./modules/search/search.routes.js",
  "./modules/coupon/coupon.routes.js",
  "./modules/payment/paymentMethod.routes.js",
  "./modules/engagement/engagement.routes.js",
  "./modules/experiment/experiment.routes.js",
];

const loaded = await Promise.all(PHASE_MODULES.map(async (path) => {
  try {
    return await import(path);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" && err.message.includes(path.split("/").pop())) return null;
    logger.error({ err: err.message, path }, "Route module failed to load");
    throw err;
  }
}));

export function mountPhaseRoutes(app) {
  for (const mod of loaded) mod?.mount?.(app, recordMountPath);
}
