import { sendSuccess } from "../../common/responses/apiResponse.js";
import { serviceabilityForUser } from "../kitchen/kitchen.service.js";
import * as locationService from "./location.service.js";

export async function updateLocationController(req, res) {
  const data = await locationService.updateCurrentLocation({
    userId: req.auth.userId,
    latitude: req.body.latitude,
    longitude: req.body.longitude,
  });
  return sendSuccess(res, { message: "Current location updated.", data });
}

export async function getLocationController(req, res) {
  const data = await locationService.getCurrentLocation(req.auth.userId);
  return sendSuccess(res, { message: "Current location fetched.", data });
}

export async function serviceabilityController(req, res) {
  const point = req.query.latitude != null && req.query.longitude != null
    ? { latitude: req.query.latitude, longitude: req.query.longitude }
    : null;
  const data = await serviceabilityForUser(req.auth.userId, point);
  return sendSuccess(res, {
    message: data.serviceable ? "Serviceable" : "Not serviceable",
    data,
  });
}
