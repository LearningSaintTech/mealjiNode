import { AppError } from "../../common/errors/AppError.js";
import { distanceKm } from "../../common/geo.js";
import { kitchenRepository } from "../kitchen/kitchen.repository.js";
import { orderingState } from "../kitchen/kitchen.hours.js";
import { estimateEtaMinutes } from "../pricing/pricing.engine.js";
import { resolveSetting } from "../settings/settings.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { DemandLog } from "./demandLog.model.js";

/** The nearest active, placed kitchen whose radius covers the point. */
export async function kitchenForPoint(latitude, longitude) {
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;
  const kitchens = await kitchenRepository.listActiveLocated();
  let nearest = null;
  let nearestKm = Infinity;
  for (const kitchen of kitchens) {
    const km = distanceKm(Number(latitude), Number(longitude), kitchen.latitude, kitchen.longitude);
    if (km <= kitchen.serviceRadiusKm && km < nearestKm) {
      nearest = kitchen;
      nearestKm = km;
    }
  }
  return nearest ? { kitchen: nearest, distanceKm: Math.round(nearestKm * 100) / 100 } : null;
}

/**
 * Everything the app shows on "Do we deliver to you?" and the home header:
 * the serving kitchen, distance, ETA, delivery fee and free-delivery threshold,
 * whether it is open now, and a message when it is not.
 */
export async function serviceabilityAt({ latitude, longitude, userId = null, source = "location", pincode = null }) {
  const match = await kitchenForPoint(latitude, longitude);
  if (!match) {
    await DemandLog.create({ userId, latitude, longitude, pincode, source }).catch(() => {});
    return {
      serviceable: false,
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
      ratingAvg: kitchen.ratingAvg || 0,
      ratingCount: kitchen.ratingCount || 0,
    },
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
      await DemandLog.create({ userId, pincode, source: "pincode" }).catch(() => {});
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
export async function resolveCustomerKitchen({ kitchenId = null, latitude = null, longitude = null, userId = null }) {
  if (kitchenId) {
    const kitchen = await Kitchen.findOne({ _id: kitchenId, status: "active" });
    if (!kitchen) throw new AppError(404, "Kitchen not found");
    return { kitchen, distanceKm: null };
  }
  const points = [];
  if (latitude != null && longitude != null) points.push({ latitude, longitude });
  if (userId) {
    const { User } = await import("../user/user.model.js");
    const { Address } = await import("../address/address.model.js");
    const user = await User.findById(userId).select("currentLocation").lean();
    if (user?.currentLocation?.latitude != null) points.push(user.currentLocation);
    const address = await Address.findOne({ user: userId, deletedAt: null }).sort({ isDefault: -1, updatedAt: -1 }).lean();
    if (address) points.push(address);
  }
  if (!points.length) throw new AppError(400, "Set your location to see the menu");
  for (const point of points) {
    const match = await kitchenForPoint(point.latitude, point.longitude);
    if (match) return match;
  }
  throw new AppError(409, "We don't deliver to your location yet", [{ field: "location", message: "NOT_SERVICEABLE" }]);
}
