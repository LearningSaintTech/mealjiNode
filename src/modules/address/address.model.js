import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    label: { type: String, enum: ["home", "work", "other"], default: "home" },
    customLabel: { type: String, default: null, trim: true, maxlength: 40 },
    recipientName: { type: String, default: null, trim: true, maxlength: 80 },
    phone: { type: String, default: null, trim: true, maxlength: 15 },
    houseFlat: { type: String, required: true, trim: true, maxlength: 120 },
    street: { type: String, default: null, trim: true, maxlength: 160 },
    locality: { type: String, default: null, trim: true, maxlength: 120 },
    landmark: { type: String, default: null, trim: true, maxlength: 120 },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    state: { type: String, default: null, trim: true, maxlength: 60 },
    pincode: { type: String, required: true, trim: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    placeId: { type: String, default: null },
    isDefault: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

addressSchema.index({ user: 1, deletedAt: 1, isDefault: -1, updatedAt: -1 });

export const Address = mongoose.model("Address", addressSchema);

const LABEL_NAMES = { home: "Home", work: "Office", other: "Other" };

/** What the app shows on the address card: the custom wording, else Home / Office / Other. */
export function displayLabel(address) {
  return address.customLabel || LABEL_NAMES[address.label] || "Other";
}

export function fullAddress(address) {
  return [address.houseFlat, address.street, address.locality, address.landmark ? `Near ${address.landmark}` : null, address.city, address.state, address.pincode]
    .filter(Boolean)
    .join(", ");
}

export function toAddress(address) {
  return {
    addressId: String(address._id),
    label: address.label,
    customLabel: address.customLabel ?? null,
    displayLabel: displayLabel(address),
    recipientName: address.recipientName ?? null,
    phone: address.phone ?? null,
    houseFlat: address.houseFlat,
    street: address.street ?? null,
    locality: address.locality ?? null,
    landmark: address.landmark ?? null,
    city: address.city,
    state: address.state ?? null,
    pincode: address.pincode,
    latitude: address.latitude,
    longitude: address.longitude,
    fullAddress: fullAddress(address),
    isDefault: Boolean(address.isDefault),
    updatedAt: address.updatedAt,
  };
}

// What an order or subscription keeps, so later edits never change it.
export function addressSnapshot(address) {
  const view = toAddress(address);
  delete view.isDefault;
  delete view.updatedAt;
  return view;
}
