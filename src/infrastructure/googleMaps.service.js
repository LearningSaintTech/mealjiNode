import axios from "axios";
import { AppError } from "../common/errors/AppError.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const client = axios.create({ timeout: 12000 });

function component(components, ...types) {
  const match = components.find((item) => types.some((type) => item.types?.includes(type)));
  return match?.long_name || null;
}

function rejectGeocode(status, errorMessage, fallback) {
  if (status === "REQUEST_DENIED") {
    logger.error({ status }, "Google Maps rejected the key");
    const billing = /billing/i.test(errorMessage || "");
    throw new AppError(
      502,
      billing
        ? "Google Maps rejected the key. Enable billing for the Geocoding API on this Cloud project."
        : "Google Maps rejected the key. Enable the Geocoding API for this key.",
    );
  }
  logger.error({ status, error: errorMessage }, "Google Maps geocoding rejected the request");
  throw new AppError(502, fallback);
}

function textualLocation(result) {
  const components = result.address_components || [];
  const streetNumber = component(components, "street_number");
  const route = component(components, "route");
  const street = [streetNumber, route].filter(Boolean).join(" ") || null;
  const area = component(components, "sublocality_level_1", "sublocality", "neighborhood");
  const city = component(components, "locality", "postal_town", "administrative_area_level_2");
  const state = component(components, "administrative_area_level_1");
  const postalCode = component(components, "postal_code");
  const country = component(components, "country");
  const locationText = result.formatted_address || [street, area, city, state, postalCode, country].filter(Boolean).join(", ");

  if (!locationText) {
    throw new AppError(400, "Could not resolve a textual location for these coordinates");
  }

  return {
    locationText,
    area,
    city,
    state,
    postalCode,
    country,
    placeId: result.place_id || null,
  };
}

function placeFromResult(result) {
  const textual = textualLocation(result);
  const location = result.geometry?.location;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) return null;
  const addressLine = [component(result.address_components || [], "street_number"), component(result.address_components || [], "route")]
    .filter(Boolean)
    .join(" ")
    || textual.locationText.split(",")[0];
  return {
    label: textual.locationText,
    addressLine: addressLine.slice(0, 160),
    area: textual.area,
    city: textual.city,
    state: textual.state,
    postalCode: textual.postalCode,
    latitude: location.lat,
    longitude: location.lng,
  };
}

export async function searchPlaces(query) {
  if (!env.googleMapsApiKey) {
    throw new AppError(503, "Google Maps is not configured");
  }

  const params = {
    address: query,
    key: env.googleMapsApiKey,
    language: env.googleMapsLanguage || "en",
  };
  if (env.googleMapsRegion) params.region = env.googleMapsRegion;

  let response;
  try {
    response = await client.get(env.googleMapsGeocodeUrl, { params });
  } catch (error) {
    logger.error({ status: error?.response?.status }, "Google Maps geocoding request failed");
    throw new AppError(502, "Could not search Google Maps");
  }

  const status = response?.data?.status;
  if (status === "ZERO_RESULTS") return [];
  if (status === "OK") {
    // One malformed result must not fail the whole search.
    return (response.data.results || []).slice(0, 5).map((result) => {
      try {
        return placeFromResult(result);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  rejectGeocode(status, response?.data?.error_message, "Could not search Google Maps");
}

export async function geocodeAddress(address) {
  if (!env.googleMapsApiKey) return null;

  const params = {
    address,
    key: env.googleMapsApiKey,
    language: env.googleMapsLanguage || "en",
  };
  if (env.googleMapsRegion) params.region = env.googleMapsRegion;

  let response;
  try {
    response = await client.get(env.googleMapsGeocodeUrl, { params });
  } catch (error) {
    logger.error({ status: error?.response?.status }, "Google Maps geocoding request failed");
    throw new AppError(502, "Could not place this kitchen address");
  }

  const status = response?.data?.status;
  const location = response?.data?.results?.[0]?.geometry?.location;
  if (status === "OK" && Number.isFinite(location?.lat) && Number.isFinite(location?.lng)) {
    return { latitude: location.lat, longitude: location.lng };
  }

  if (status === "ZERO_RESULTS") {
    throw new AppError(400, "Could not place this kitchen address");
  }

  rejectGeocode(status, response?.data?.error_message, "Could not place this kitchen address");
}

export async function reverseGeocode({ latitude, longitude }) {
  if (!env.googleMapsApiKey) {
    throw new AppError(503, "Google Maps is not configured");
  }

  const params = {
    latlng: `${latitude},${longitude}`,
    key: env.googleMapsApiKey,
    language: env.googleMapsLanguage || "en",
  };
  if (env.googleMapsRegion) params.region = env.googleMapsRegion;

  let response;
  try {
    response = await client.get(env.googleMapsGeocodeUrl, { params });
  } catch (error) {
    logger.error({ status: error?.response?.status }, "Google Maps geocoding request failed");
    throw new AppError(502, "Could not resolve the location");
  }

  const status = response?.data?.status;
  if (status === "OK" && response.data.results?.[0]) {
    return textualLocation(response.data.results[0]);
  }

  if (status === "ZERO_RESULTS") {
    throw new AppError(400, "Could not resolve a textual location for these coordinates");
  }

  rejectGeocode(status, response?.data?.error_message, "Could not resolve the location");
}

// ---- Customer address search (Places Autocomplete + Place Details) ----

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place";

function requireKey() {
  if (!env.googleMapsApiKey) throw new AppError(503, "Address search is not configured");
}

/** Place predictions for a partial address, biased to a point when given. */
export async function autocompletePlaces({ input, latitude, longitude, sessionToken }) {
  requireKey();
  const params = {
    input,
    key: env.googleMapsApiKey,
    language: env.googleMapsLanguage || "en",
    components: "country:in",
  };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    params.location = `${latitude},${longitude}`;
    params.radius = 30000;
  }
  if (sessionToken) params.sessiontoken = sessionToken;
  let response;
  try {
    response = await client.get(`${PLACES_BASE}/autocomplete/json`, { params });
  } catch (error) {
    logger.error({ status: error?.response?.status }, "Google Places autocomplete failed");
    throw new AppError(502, "Could not search addresses");
  }
  const status = response?.data?.status;
  if (status === "ZERO_RESULTS") return [];
  if (status !== "OK") rejectGeocode(status, response?.data?.error_message, "Could not search addresses");
  return (response.data.predictions || []).slice(0, 8).map((item) => ({
    placeId: item.place_id,
    primaryText: item.structured_formatting?.main_text || item.description,
    secondaryText: item.structured_formatting?.secondary_text || "",
    description: item.description,
  }));
}

/** Full address and coordinates for a place ID. */
export async function placeDetails({ placeId, sessionToken }) {
  requireKey();
  const params = {
    place_id: placeId,
    key: env.googleMapsApiKey,
    language: env.googleMapsLanguage || "en",
    fields: "place_id,formatted_address,address_component,geometry/location,name",
  };
  if (sessionToken) params.sessiontoken = sessionToken;
  let response;
  try {
    response = await client.get(`${PLACES_BASE}/details/json`, { params });
  } catch (error) {
    logger.error({ status: error?.response?.status }, "Google Place details failed");
    throw new AppError(502, "Could not load this address");
  }
  const status = response?.data?.status;
  if (status === "NOT_FOUND" || status === "INVALID_REQUEST") throw new AppError(404, "Place not found");
  if (status !== "OK") rejectGeocode(status, response?.data?.error_message, "Could not load this address");
  const result = response.data.result;
  const textual = textualLocation(result);
  return {
    placeId: result.place_id,
    name: result.name || null,
    fullAddress: textual.locationText,
    locality: textual.area,
    city: textual.city,
    state: textual.state,
    pincode: textual.postalCode,
    latitude: result.geometry?.location?.lat ?? null,
    longitude: result.geometry?.location?.lng ?? null,
  };
}
