import { AppError } from "../../common/errors/AppError.js";
import { reverseGeocode } from "../../infrastructure/googleMaps.service.js";
import { toCurrentLocation } from "../user/user.mapper.js";
import { userRepository } from "../user/user.repository.js";

export async function updateCurrentLocation({ userId, latitude, longitude }) {
  // The pin is what matters for delivery; the place name is a nicety. If
  // Google is down or unconfigured, save the pin with a plain label.
  let textual;
  try {
    textual = await reverseGeocode({ latitude, longitude });
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
