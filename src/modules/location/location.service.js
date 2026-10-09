import { AppError } from "../../common/errors/AppError.js";
import { reverseGeocode } from "../../infrastructure/googleMaps.service.js";
import { storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { toCurrentLocation } from "../user/user.mapper.js";
import { userRepository } from "../user/user.repository.js";

// The place name for a point barely changes: points ~10 m apart share one Google
// lookup, cached for 30 days (fewer paid calls, faster saves at scale).
const PLACE_TTL_SEC = 30 * 86_400;
async function placeNameFor(latitude, longitude) {
  const key = `geo:rev:${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
  const cached = await storeGetOptional(key);
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const textual = await reverseGeocode({ latitude, longitude });
  await storeSet(key, JSON.stringify(textual), PLACE_TTL_SEC).catch(() => {});
  return textual;
}

export async function updateCurrentLocation({ userId, latitude, longitude }) {
  // The pin is what matters for delivery; the place name is a nicety. If
  // Google is down or unconfigured, save the pin with a plain label.
  let textual;
  try {
    textual = await placeNameFor(latitude, longitude);
  } catch (err) {
    if (!(err instanceof AppError) || ![400, 404, 502, 503].includes(err.statusCode)) throw err;
    textual = { locationText: "Pinned location", area: null, city: null, state: null, postalCode: null, country: null };
  }
  const user = await userRepository.updateById(userId, {
    currentLocation: {
      latitude,
      longitude,
      ...textual,
      updatedAt: new Date(),
    },
  });
  return toCurrentLocation(user.currentLocation);
}

export async function getCurrentLocation(userId) {
  const user = await userRepository.findById(userId);
  const location = toCurrentLocation(user?.currentLocation);
  if (!location) throw new AppError(404, "Current location is not set");
  return location;
}
