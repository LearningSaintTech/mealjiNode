import { shippingConfigured, shippingProvider } from "./shipping.provider.js";

/**
 * Delivery provider adapters. Each implements:
 *   quote({ pickup, drop }) → { pricePaise, etaMinutes } | null
 *   create(job, { order, kitchen }) → { providerJobId, status, trackingUrl?, costPaise?, deliveryOtp? }
 *   cancel(job) → void
 *   parseWebhook(rawBody, headers) → { providerJobId, version?, status, rider?, location?, costPaise?, note?, pickedUp? } | null
 *     (rawBody is a Buffer so the adapter can check the signature; throw AppError(401) when it fails)
 * "manual" and "self" are built in: the kitchen books, assigns the rider and
 * moves the job forward from the kitchen console. A third-party adapter (Porter,
 * Shadowfax, Borzo…) is registered here once the partner is chosen; orders, the
 * app and the consoles do not change.
 */

const manual = {
  key: "manual",
  label: "Manual (kitchen hands over to a rider)",
  managedByKitchen: true,
  async quote() {
    return null;
  },
  async create() {
    return { providerJobId: null, status: "booked", trackingUrl: null };
  },
  async cancel() {},
  parseWebhook() {
    return null;
  },
};

const self = {
  ...manual,
  key: "self",
  label: "Kitchen delivers itself",
};

const registry = new Map([[manual.key, manual], [self.key, self]]);
// Our own delivery platform, once its API URL and key are set.
if (shippingConfigured()) registry.set(shippingProvider.key, shippingProvider);

export function registerProvider(adapter) {
  registry.set(adapter.key, adapter);
}

export function getProvider(key) {
  return registry.get(key) || manual;
}

export function listProviders() {
  return [...registry.values()].map((adapter) => ({ key: adapter.key, label: adapter.label, managedByKitchen: Boolean(adapter.managedByKitchen) }));
}
