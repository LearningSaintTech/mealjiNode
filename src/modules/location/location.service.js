import { AppError } from "../../common/errors/AppError.js";
import { reverseGeocode } from "../../infrastructure/googleMaps.service.js";
import { toCurrentLocation } from "../user/user.mapper.js";
import { userRepository } from "../user/user.repository.js";

export async function updateCurrentLocation({ userId, latitude, longitude }) {
  const textual = await reverseGeocode({ latitude, longitude });
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
