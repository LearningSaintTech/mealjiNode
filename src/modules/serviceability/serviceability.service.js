import { AppError } from "../../common/errors/AppError.js";
import { distanceKm } from "../../common/geo.js";
import { kitchenRepository } from "../kitchen/kitchen.repository.js";
import { orderingState } from "../kitchen/kitchen.hours.js";
import { estimateEtaMinutes } from "../pricing/pricing.engine.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { DemandLog } from "./demandLog.model.js";

const roundKm = (km) => Math.round(km * 100) / 100;

/** Every active, placed kitchen whose radius covers the point, nearest first. */
export async function kitchensForPoint(latitude, longitude) {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return [];
  const kitchens = await kitchenRepository.listActiveLocated();
  return kitchens
    .map((kitchen) => ({ kitchen, km: distanceKm(Number(latitude), Number(longitude), kitchen.latitude, kitchen.longitude) }))
    .filter(({ kitchen, km }) => km <= kitchen.serviceRadiusKm)
    .sort((a, b) => a.km - b.km)
    .map(({ kitchen, km }) => ({ kitchen, distanceKm: roundKm(km), canOrder: orderingState(kitchen).canOrder }));
}

/**
 * The kitchen that serves a point. With `preferOpen` (default) it is the nearest
 * kitchen that can take orders now, else the nearest one; without it, always the nearest.
 */
export async function kitchenForPoint(latitude, longitude, { preferOpen = true } = {}) {
  const matches = await kitchensForPoint(latitude, longitude);
  if (!matches.length) return null;
  const pick = (preferOpen && matches.find((match) => match.canOrder)) || matches[0];
  return { kitchen: pick.kitchen, distanceKm: pick.distanceKm };
}

/** Records unmet demand once per user, place (~100 m) and day, so repeated checks don't flood the log. */
async function logDemand({ userId = null, latitude = null, longitude = null, pincode = null, source }) {
  const { storeGetOptional, storeSet } = await import("../../infrastructure/redisStore.js");
  const place = pincode || `${Number(latitude).toFixed(3)},${Number(longitude).toFixed(3)}`;
  const key = `demand:${userId || "anon"}:${place}`;
  const seen = await storeGetOptional(key);
  if (seen.ok && seen.value) return;
  await storeSet(key, "1", 86_400).catch(() => {});
  await DemandLog.create({ userId, latitude, longitude, pincode, source }).catch(() => {});
}

/** Whether this kitchen's radius covers the point. */
export function kitchenCovers(kitchen, latitude, longitude) {
  if (!kitchen || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return false;
  if (!Number.isFinite(kitchen.latitude) || !Number.isFinite(kitchen.longitude)) return false;
  return distanceKm(Number(latitude), Number(longitude), kitchen.latitude, kitchen.longitude) <= kitchen.serviceRadiusKm;
}

/**
 * Everything the app shows on "Do we deliver to you?" and the home header:
 * the serving kitchen, distance, ETA, delivery fee and free-delivery threshold,
 * whether it is open now, and a message when it is not.
 */
export async function serviceabilityAt({ latitude, longitude, userId = null, source = "location", pincode = null }) {
  const matches = await kitchensForPoint(latitude, longitude);
  const match = matches.find((item) => item.canOrder) || matches[0];
  if (!match) {
    await logDemand({ userId, latitude, longitude, pincode, source });
    return {
      serviceable: false,
      reason: "not_serviceable",
      kitchen: null,
      distanceKm: null,
      message: "We don't deliver here yet. We'll let you know when we do.",
    };
  }
  const { kitchen, distanceKm: km } = match;
  const [pricing, policy, delivery] = await Promise.all([
    resolveSetting("pricing", { kitchenId: kitchen._id, city: kitchen.city }),
    resolveSetting("order_policy", { kitchenId: kitchen._id, city: kitchen.city }),
    resolveSetting("delivery", { kitchenId: kitchen._id, city: kitchen.city }),
  ]);
  const state = orderingState(kitchen);
  const etaMinutes = estimateEtaMinutes({
    prepMinutes: policy.values.avgPrepMinutes,
    distanceKm: km,
    minutesPerKm: delivery.values.minutesPerKm,
    bufferMinutes: delivery.values.etaBufferMinutes,
  });
  return {
    serviceable: true,
    distanceKm: km,
    etaMinutes,
    etaLabel: `${Math.max(5, etaMinutes - 5)}–${etaMinutes + 5} min`,
    deliveryFeePaise: pricing.values.deliveryFeeMode === "flat" ? pricing.values.deliveryFeePaise : null,
    deliveryFeeMode: pricing.values.deliveryFeeMode,
    freeDeliveryAbovePaise: pricing.values.freeDeliveryAbovePaise || null,
    minOrderPaise: policy.values.minOrderPaise || 0,
    codEnabled: policy.values.codEnabled,
    pickupEnabled: policy.values.pickupEnabled,
    isOpenNow: state.canOrder,
    // null when ordering is open; "closed" (outside hours), "paused" or "kitchen_unavailable".
    reason: state.canOrder ? null : state.reason,
    opensAt: state.opensAt || null,
    message: state.message,
    kitchen: {
      kitchenId: String(kitchen._id),
      name: kitchen.name,
      serviceRadiusKm: kitchen.serviceRadiusKm,
      acceptingOrders: Boolean(kitchen.acceptingOrders),
      opensAt: kitchen.opensAt,
      closesAt: kitchen.closesAt,
      area: kitchen.area ?? null,
      city: kitchen.city,
      ratingAvg: Math.round((kitchen.ratingAvg || 0) * 10) / 10,
      ratingCount: kitchen.ratingCount || 0,
    },
    alternatives: matches
      .filter((item) => item.kitchen !== kitchen)
      .map((item) => ({
        kitchenId: String(item.kitchen._id),
        name: item.kitchen.name,
        area: item.kitchen.area ?? null,
        city: item.kitchen.city,
        distanceKm: item.distanceKm,
        isOpenNow: item.canOrder,
        ratingAvg: Math.round((item.kitchen.ratingAvg || 0) * 10) / 10,
        ratingCount: item.kitchen.ratingCount || 0,
      })),
  };
}

/** Serviceability for a pincode: geocodes the pincode centre (cached by Google layer). */
export async function serviceabilityForPincode(pincode, { userId = null, geocode }) {
  if (!/^\d{6}$/.test(String(pincode))) throw new AppError(422, "Enter a 6-digit pincode");
  const point = await geocode(`${pincode}, India`);
  if (!point) {
    // Without geocoding, fall back to kitchens registered at that pincode.
    const kitchen = await Kitchen.findOne({ status: "active", postalCode: String(pincode) });
    if (!kitchen) {
      await logDemand({ userId, pincode, source: "pincode" });
      return { serviceable: false, kitchen: null, distanceKm: null, message: "We don't deliver to this pincode yet." };
    }
    return serviceabilityAt({ latitude: kitchen.latitude, longitude: kitchen.longitude, userId, source: "pincode", pincode });
  }
  return serviceabilityAt({ latitude: point.latitude, longitude: point.longitude, userId, source: "pincode", pincode });
}

/**
 * The kitchen that serves this customer: an explicit active `kitchenId`, else
 * the kitchen covering the given point, their current location, or their
 * default address. Throws 409 NOT_SERVICEABLE when nothing covers them.
 */
export async function resolveCustomerKitchen({ kitchenId = null, latitude = null, longitude = null, userId = null, user = null }) {
  if (kitchenId) {
    const kitchen = await kitchenRepository.findActiveById(kitchenId);
    if (!kitchen || kitchen.status !== "active") throw new AppError(404, "Kitchen not found");
    return { kitchen, distanceKm: null };
  }
  const points = [];
  // A point the app sends (map pin, chosen address) is the answer on its own:
  // never fall back to another saved location when that point is not served.
  const explicit = latitude != null && longitude != null;
  if (explicit) points.push({ latitude, longitude });
  if (userId && !explicit) {
    const { User } = await import("../user/user.model.js");
    const { Address } = await import("../address/address.model.js");
    // The signed-in user is already loaded by the auth check; the default
    // address is read only when the current location does not resolve.
    const current = (user || await User.findById(userId).select("currentLocation").lean())?.currentLocation;
    if (current?.latitude != null) {
      const match = await kitchenForPoint(current.latitude, current.longitude);
      if (match) return { ...match, point: { latitude: current.latitude, longitude: current.longitude } };
    }
    const address = await Address.findOne({ user: userId, deletedAt: null }).sort({ isDefault: -1, updatedAt: -1 }).lean();
    if (address) points.push(address);
  }
  if (!points.length) throw new AppError(400, "Set your location to see the menu");
  for (const point of points) {
    const match = await kitchenForPoint(point.latitude, point.longitude);
    // `point` = where the customer is (for distance, ETA and "Deliver to").
    if (match) return { ...match, point: { latitude: point.latitude, longitude: point.longitude } };
  }
  throw new AppError(409, "We don't deliver to your location yet", [{ field: "location", message: "NOT_SERVICEABLE" }]);
}
