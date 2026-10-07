import { AppError } from "../../common/errors/AppError.js";
import { objectId } from "../../common/http.js";
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

export async function createAddress(userId, input) {
  const count = await Address.countDocuments({ user: userId, deletedAt: null });
  if (count >= MAX_ADDRESSES) throw new AppError(409, `You can save up to ${MAX_ADDRESSES} addresses`);
  const makeDefault = input.isDefault === true || count === 0;
  if (makeDefault) await Address.updateMany({ user: userId, isDefault: true }, { $set: { isDefault: false } });
  const address = await Address.create({ ...clean(input), user: userId, isDefault: makeDefault });
  return withServiceability(address);
}

export async function updateAddress(userId, addressId, input) {
  const address = await getOwnAddress(userId, addressId);
  Object.assign(address, clean(input));
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
