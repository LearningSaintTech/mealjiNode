import axios from "axios";
import { AppError } from "../common/errors/AppError.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const client = axios.create({ timeout: 12000 });

function component(components, ...types) {
  const match = components.find((item) => types.some((type) => item.types?.includes(type)));
  return match?.long_name || null;
}

function rejectGeocode(status, errorMessage, fallback, api = "Geocoding API") {
  if (status === "REQUEST_DENIED") {
    logger.error({ status }, "Google Maps rejected the key");
    const billing = /billing/i.test(errorMessage || "");
    throw new AppError(
      502,
      billing
        ? `Google Maps rejected the key. Enable billing for the ${api} on this Cloud project.`
        : `Google Maps rejected the key. Enable the ${api} for this key.`,
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
  const result = response?.data?.results?.[0];
  const location = result?.geometry?.location;
  if (status === "OK" && Number.isFinite(location?.lat) && Number.isFinite(location?.lng)) {
    // `vague`: Google only matched the whole country or state (e.g. a made-up address).
    const vague = (result.types || []).some((type) => type === "country" || type === "administrative_area_level_1");
    return { latitude: location.lat, longitude: location.lng, vague };
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

// ---- Customer address search (Places API (New): Autocomplete + Place Details) ----

const PLACES_BASE = "https://places.googleapis.com/v1";

function requireKey() {
  if (!env.googleMapsApiKey) throw new AppError(503, "Address search is not configured");
}

/** Maps a Places API (New) error response to our error; the key problems name the API to enable. */
function rejectPlaces(error, fallback) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.error;
  if (status === 404 || detail?.status === "NOT_FOUND" || detail?.status === "INVALID_ARGUMENT") throw new AppError(404, "Place not found");
  if (status === 403 || detail?.status === "PERMISSION_DENIED") {
    logger.error({ status, error: detail?.message }, "Google Places rejected the key");
    throw new AppError(502, "Google Maps rejected the key. Enable the Places API (New) for this key.");
  }
  logger.error({ status, error: detail?.message }, "Google Places request failed");
  throw new AppError(502, fallback);
}

const placesHeaders = (fieldMask) => ({ "X-Goog-Api-Key": env.googleMapsApiKey, ...(fieldMask ? { "X-Goog-FieldMask": fieldMask } : {}) });

/** Place predictions for a partial address, biased to a point when given. */
export async function autocompletePlaces({ input, latitude, longitude, sessionToken }) {
  requireKey();
  const body = { input, languageCode: env.googleMapsLanguage || "en", includedRegionCodes: ["in"] };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    body.locationBias = { circle: { center: { latitude, longitude }, radius: 30000 } };
  }
  if (sessionToken) body.sessionToken = sessionToken;
  let response;
  try {
    response = await client.post(`${PLACES_BASE}/places:autocomplete`, body, { headers: placesHeaders() });
  } catch (error) {
    if (error?.response?.status === 404) return [];
    rejectPlaces(error, "Could not search addresses");
  }
  return (response.data?.suggestions || [])
    .map((item) => item.placePrediction)
    .filter(Boolean)
    .slice(0, 8)
    .map((item) => ({
      placeId: item.placeId,
      primaryText: item.structuredFormat?.mainText?.text || item.text?.text || "",
      secondaryText: item.structuredFormat?.secondaryText?.text || "",
      description: item.text?.text || "",
    }));
}

/** Full address and coordinates for a place ID. */
export async function placeDetails({ placeId, sessionToken }) {
  requireKey();
  const params = { languageCode: env.googleMapsLanguage || "en" };
  if (sessionToken) params.sessionToken = sessionToken;
  let response;
  try {
    response = await client.get(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
      params,
      headers: placesHeaders("id,displayName,formattedAddress,addressComponents,location"),
    });
  } catch (error) {
    rejectPlaces(error, "Could not load this address");
  }
  const place = response.data || {};
  // Same shape as the Geocoding result so textualLocation can read it.
  const textual = textualLocation({
    formatted_address: place.formattedAddress,
    place_id: place.id,
    address_components: (place.addressComponents || []).map((item) => ({ long_name: item.longText, short_name: item.shortText, types: item.types })),
  });
  return {
    placeId: place.id,
    name: place.displayName?.text || null,
    fullAddress: textual.locationText,
    locality: textual.area,
    city: textual.city,
    state: textual.state,
    pincode: textual.postalCode,
    latitude: place.location?.latitude ?? null,
    longitude: place.location?.longitude ?? null,
  };
}
