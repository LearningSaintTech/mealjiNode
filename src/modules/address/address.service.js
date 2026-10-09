import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
import { logger } from "../../config/logger.js";
import { geocodeAddress } from "../../infrastructure/googleMaps.service.js";
import { Kitchen } from "../kitchen/kitchen.model.js";
import { kitchenForPoint } from "../serviceability/serviceability.service.js";
import { Address, toAddress } from "./address.model.js";

const MAX_ADDRESSES = 20;
const FIELDS = ["label", "customLabel", "recipientName", "phone", "houseFlat", "street", "locality", "landmark", "city", "state", "pincode", "latitude", "longitude", "placeId"];

function clean(input) {
  const out = {};
  for (const key of FIELDS) {
    if (input[key] === undefined) continue;
    const value = input[key];
    out[key] = typeof value === "string" ? value.trim() || null : value;
  }
  return out;
}

async function withServiceability(address) {
  const view = toAddress(address);
  const match = await kitchenForPoint(address.latitude, address.longitude);
  return {
    ...view,
    serviceable: Boolean(match),
    kitchenId: match ? String(match.kitchen._id) : null,
    distanceKm: match ? match.distanceKm : null,
  };
}

export async function listAddresses(userId) {
  const items = await Address.find({ user: userId, deletedAt: null }).sort({ isDefault: -1, updatedAt: -1 });
  return Promise.all(items.map(withServiceability));
}

export async function getOwnAddress(userId, addressId) {
  const address = await Address.findOne({ _id: objectId(addressId, "address ID"), user: userId, deletedAt: null });
  if (!address) throw new AppError(404, "Address not found");
  return address;
}

const PLACE_FIELDS = ["houseFlat", "street", "locality", "city", "state", "pincode"];
const NOT_PLACED = "We couldn't find this address. Check the pincode or pin it on the map.";

/**
 * Coordinates for an address typed without a map pin: the full text, then the
 * pincode centre, then a kitchen registered at that pincode. 422 when none works.
 */
async function placeAddress(fields, { geocodePincode } = {}) {
  const attempts = [
    () => geocodeAddress([...PLACE_FIELDS.map((key) => fields[key]), "India"].filter(Boolean).join(", ")),
    () => (geocodePincode || geocodeAddress)(`${fields.pincode}, India`),
    async () => {
      const kitchen = await Kitchen.findOne({ status: "active", postalCode: String(fields.pincode) }).select("latitude longitude").lean();
      return kitchen ? { latitude: kitchen.latitude, longitude: kitchen.longitude } : null;
    },
  ];
  for (const attempt of attempts) {
    try {
      const point = await attempt();
      if (Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude) && !point.vague) return { latitude: point.latitude, longitude: point.longitude };
    } catch (err) {
      if (err?.statusCode >= 500) logger.warn({ err: err.message }, "Address geocoding failed");
    }
  }
  throw new AppError(422, NOT_PLACED, [{ field: "pincode", message: NOT_PLACED }]);
}

const hasPoint = (fields) => Number.isFinite(fields.latitude) && Number.isFinite(fields.longitude);

export async function createAddress(userId, input, options = {}) {
  const fields = clean(input);
  if (!hasPoint(fields)) Object.assign(fields, await placeAddress(fields, options));
  const count = await Address.countDocuments({ user: userId, deletedAt: null });
  if (count >= MAX_ADDRESSES) throw new AppError(409, `You can save up to ${MAX_ADDRESSES} addresses`);
  const makeDefault = input.isDefault === true || count === 0;
  if (makeDefault) await Address.updateMany({ user: userId, isDefault: true }, { $set: { isDefault: false } });
  const address = await Address.create({ ...fields, user: userId, isDefault: makeDefault });
  return withServiceability(address);
}

export async function updateAddress(userId, addressId, input, options = {}) {
  const address = await getOwnAddress(userId, addressId);
  const fields = clean(input);
  // Text changed without a new pin: place it again so delivery checks stay right.
  const moved = PLACE_FIELDS.some((key) => key in fields && fields[key] !== address[key]);
  if (moved && !hasPoint(fields)) Object.assign(fields, await placeAddress({ ...address.toObject(), ...fields }, options));
  Object.assign(address, fields);
  if (input.isDefault === true && !address.isDefault) {
    await Address.updateMany({ user: userId, isDefault: true }, { $set: { isDefault: false } });
    address.isDefault = true;
  }
  await address.save();
  return withServiceability(address);
}

export async function setDefaultAddress(userId, addressId) {
  const address = await getOwnAddress(userId, addressId);
  await Address.updateMany({ user: userId, isDefault: true }, { $set: { isDefault: false } });
  address.isDefault = true;
  await address.save();
  return withServiceability(address);
}

// Soft delete: orders keep their own snapshot. The next newest becomes default.
export async function deleteAddress(userId, addressId) {
  const address = await getOwnAddress(userId, addressId);
  address.deletedAt = new Date();
  const wasDefault = address.isDefault;
  address.isDefault = false;
  await address.save();
  if (wasDefault) {
    const next = await Address.findOne({ user: userId, deletedAt: null }).sort({ updatedAt: -1 });
    if (next) await Address.updateOne({ _id: next._id }, { $set: { isDefault: true } });
  }
  return { addressId: String(address._id), deleted: true };
}

export async function defaultAddress(userId) {
  return Address.findOne({ user: userId, deletedAt: null }).sort({ isDefault: -1, updatedAt: -1 });
}
