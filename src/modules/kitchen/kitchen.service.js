import { AppError } from "../../common/errors/AppError.js";
import { escapeRegex } from "../../common/text.util.js";
import { countryOrDefault, normalizeMobile } from "../../common/phone.util.js";
import { env } from "../../config/env.js";
import { geocodeAddress, searchPlaces } from "../../infrastructure/googleMaps.service.js";
import { roleRepository } from "../role/role.repository.js";
import { userRepository } from "../user/user.repository.js";
import { toPublicUser } from "../user/user.mapper.js";
import { toKitchen } from "./kitchen.mapper.js";
import { kitchenRepository } from "./kitchen.repository.js";
import { isSuspended, phoneChangePatch, reinstatePatch, suspendPatch } from "../user/user.status.js";

function blankToNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function kitchenPatch(input, { acceptingOrders }) {
  return {
    name: input.name.trim(),
    contactName: input.contactName.trim(),
    countryCode: countryOrDefault(input.countryCode),
    phoneNumber: normalizeMobile(input.phoneNumber),
    addressLine: input.addressLine.trim(),
    area: blankToNull(input.area),
    city: input.city.trim(),
    state: blankToNull(input.state),
    postalCode: blankToNull(input.postalCode),
    serviceRadiusKm: Number(input.serviceRadiusKm),
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    serviceNote: typeof input.serviceNote === "string" ? input.serviceNote.trim() : "",
    status: input.status || "onboarding",
    acceptingOrders: input.status === "active" ? acceptingOrders : false,
  };
}

function addressText(input) {
  return [input.addressLine, input.area, input.city, input.state, input.postalCode, "India"]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(", ");
}

function finitePoint(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng };
}

async function resolveKitchenPoint(input, previous) {
  const provided = finitePoint(input.latitude, input.longitude);
  if (provided) return provided;

  if (env.googleMapsApiKey) {
    const point = await geocodeAddress(addressText(input));
    if (!point) throw new AppError(400, "Could not place this kitchen address");
    return point;
  }
  if (previous?.latitude != null && previous?.longitude != null) {
    return { latitude: previous.latitude, longitude: previous.longitude };
  }
  return { latitude: null, longitude: null };
}

function assertPlacedIfActive(patch) {
  if (patch.status === "active" && (patch.latitude == null || patch.longitude == null)) {
    throw new AppError(409, "Place this kitchen on the map before marking it active");
  }
}

async function assertPhoneAvailable(countryCode, phoneNumber, userId) {
  const existing = await userRepository.findByPhone(countryCode, phoneNumber);
  if (existing && String(existing._id) !== String(userId || "")) {
    throw new AppError(409, "An account with this phone number already exists");
  }
}

export async function onboardKitchen(input) {
  const patch = kitchenPatch(input, { acceptingOrders: false });
  await assertPhoneAvailable(patch.countryCode, patch.phoneNumber);
  if (await kitchenRepository.findByPhone(patch.phoneNumber)) {
    throw new AppError(409, "A kitchen with this phone number already exists");
  }
  Object.assign(patch, await resolveKitchenPoint(input, null));
  assertPlacedIfActive(patch);

  const role = await roleRepository.findBySlug("kitchen_admin");
  if (!role) throw new AppError(500, "Roles are not seeded");

  const kitchen = await kitchenRepository.create(patch);
  try {
    const user = await userRepository.create({
      name: patch.contactName,
      countryCode: patch.countryCode,
      phoneNumber: patch.phoneNumber,
      role: role._id,
      kitchen: kitchen._id,
      isActive: false,
      isNumberVerified: false,
    });
    const linked = await kitchenRepository.updateById(kitchen._id, { user: user._id });
    return toKitchen(linked);
  } catch (error) {
    await kitchenRepository.deleteById(kitchen._id);
    throw error;
  }
}

export async function searchKitchenPlaces(query) {
  const text = String(query || "").trim();
  if (text.length < 3) throw new AppError(422, "Enter at least 3 characters");
  return searchPlaces(text);
}

export async function listKitchens(query) {
  const page = query.page || 1;
  const limit = query.limit || 20;
  const { items, total } = await kitchenRepository.list({
    status: query.status,
    phone: query.phone,
    q: query.q ? escapeRegex(query.q.trim()) : "",
    page,
    limit,
  });
  return { items: items.map(toKitchen), page, limit, total };
}

export async function getKitchen(kitchenId) {
  const kitchen = await kitchenRepository.findById(kitchenId);
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  return toKitchen(kitchen);
}

export async function updateKitchen(kitchenId, input) {
  const kitchen = await kitchenRepository.findById(kitchenId);
  if (!kitchen) throw new AppError(404, "Kitchen not found");

  const patch = kitchenPatch(input, { acceptingOrders: kitchen.acceptingOrders });
  await assertPhoneAvailable(patch.countryCode, patch.phoneNumber, kitchen.user);
  Object.assign(patch, await resolveKitchenPoint(input, kitchen));
  assertPlacedIfActive(patch);
  // The admin account is updated first (its phone is unique, so a clash fails
  // here before the kitchen changes); if the kitchen write then fails, the
  // account is put back so the two never disagree.
  let previousUser = null;
  if (kitchen.user) {
    previousUser = await userRepository.findById(kitchen.user);
    const phoneChanged = patch.phoneNumber !== kitchen.phoneNumber || patch.countryCode !== kitchen.countryCode;
    await userRepository.updateById(kitchen.user, {
      name: patch.contactName,
      countryCode: patch.countryCode,
      phoneNumber: patch.phoneNumber,
      // A new number belongs to whoever holds it now: it signs in again with OTP
      // and sessions opened with the old number end. A suspension stays.
      ...(phoneChanged ? phoneChangePatch() : {}),
    });
  }
  let updated;
  try {
    updated = await kitchenRepository.updateById(kitchen._id, patch);
  } catch (err) {
    if (previousUser) {
      await userRepository.updateById(previousUser._id, {
        name: previousUser.name,
        countryCode: previousUser.countryCode,
        phoneNumber: previousUser.phoneNumber,
        isNumberVerified: previousUser.isNumberVerified,
        isActive: previousUser.isActive,
        sessionsRevokedAt: previousUser.sessionsRevokedAt,
      }).catch(() => {});
    }
    throw err;
  }
  return toKitchen(updated);
}

export async function setKitchenStatus(kitchenId, status) {
  const kitchen = await kitchenRepository.findById(kitchenId);
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  if (kitchen.status === status) return toKitchen(kitchen);
  if (status === "active" && (kitchen.latitude == null || kitchen.longitude == null)) {
    throw new AppError(409, "Place this kitchen on the map before marking it active");
  }
  const updated = await kitchenRepository.updateById(kitchen._id, {
    status,
    ...(status === "active" ? {} : { acceptingOrders: false }),
  });
  return toKitchen(updated);
}

async function kitchenForAccount(userId) {
  const user = await userRepository.findById(userId);
  if (!user?.kitchen) throw new AppError(404, "Kitchen not found");
  const kitchen = await kitchenRepository.findById(user.kitchen);
  if (!kitchen) throw new AppError(404, "Kitchen not found");
  return kitchen;
}

export async function getOwnKitchen(userId) {
  return toKitchen(await kitchenForAccount(userId));
}

export async function configureOwnKitchen(userId, input) {
  const kitchen = await kitchenForAccount(userId);
  const point = await resolveKitchenPoint(input, kitchen);
  const updated = await kitchenRepository.updateById(kitchen._id, {
    name: input.name.trim(),
    contactName: input.contactName.trim(),
    addressLine: input.addressLine.trim(),
    area: blankToNull(input.area),
    city: input.city.trim(),
    state: blankToNull(input.state),
    postalCode: blankToNull(input.postalCode),
    latitude: point.latitude,
    longitude: point.longitude,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    serviceNote: typeof input.serviceNote === "string" ? input.serviceNote.trim() : "",
  });
  // The contact is the kitchen admin's account, whoever is editing.
  if (kitchen.user) await userRepository.updateById(kitchen.user, { name: input.contactName.trim() });
  return toKitchen(updated);
}

export async function setAcceptingOrders(userId, acceptingOrders) {
  const kitchen = await kitchenForAccount(userId);
  if (kitchen.status !== "active") {
    throw new AppError(409, "Orders can be accepted after a super admin marks the kitchen active");
  }
  const updated = await kitchenRepository.updateById(kitchen._id, { acceptingOrders });
  return toKitchen(updated);
}

export async function serviceabilityForUser(userId, point) {
  let latitude = point?.latitude;
  let longitude = point?.longitude;
  if (latitude == null || longitude == null) {
    const user = await userRepository.findById(userId);
    latitude = user?.currentLocation?.latitude;
    longitude = user?.currentLocation?.longitude;
  }
  if (latitude == null || longitude == null) {
    throw new AppError(400, "Set your current location before checking service.");
  }
  // Lazy import: serviceability depends on settings, which depends on kitchens.
  const { serviceabilityAt } = await import("../serviceability/serviceability.service.js");
  return serviceabilityAt({ latitude: Number(latitude), longitude: Number(longitude), userId });
}

export async function listKitchenTeam(userId) {
  const kitchen = await kitchenForAccount(userId);
  const people = await userRepository.listByKitchen(kitchen._id);
  return people.map(toPublicUser);
}

export async function inviteKitchenSubadmin(userId, { name, countryCode, phoneNumber, roleSlug = "kitchen_subadmin" }) {
  const kitchen = await kitchenForAccount(userId);
  const phone = normalizeMobile(phoneNumber);
  const code = countryOrDefault(countryCode);
  await assertPhoneAvailable(code, phone);
  const role = await roleRepository.findBySlug(roleSlug || "kitchen_subadmin");
  if (!role) throw new AppError(roleSlug === "kitchen_subadmin" ? 500 : 404, roleSlug === "kitchen_subadmin" ? "Roles are not seeded" : "Role not found");
  if (role.slug === "kitchen_admin" || role.scope !== "kitchen" || (role.kitchen && String(role.kitchen) !== String(kitchen._id))) {
    throw new AppError(400, "Choose a kitchen team role");
  }
  const user = await userRepository.create({
    name: name.trim(),
    countryCode: code,
    phoneNumber: phone,
    role: role._id,
    kitchen: kitchen._id,
    isActive: false,
    isNumberVerified: false,
  });
  return toPublicUser(user);
}

export async function updateKitchenSubadminStatus({ actorUserId, userId, isActive }) {
  const kitchen = await kitchenForAccount(actorUserId);
  const user = await userRepository.findById(userId);
  if (!user || String(user.kitchen || "") !== String(kitchen._id)) {
    throw new AppError(404, "Kitchen staff not found");
  }
  if (user.role?.slug === "kitchen_admin") {
    throw new AppError(400, "The kitchen admin is managed by MealJi");
  }
  if (String(user._id) === String(actorUserId)) {
    throw new AppError(403, "You cannot suspend your own account");
  }
  const suspend = isActive === false;
  if (isSuspended(user) === suspend) return toPublicUser(user);
  const updated = await userRepository.updateById(user._id, suspend ? suspendPatch() : reinstatePatch(user));
  return toPublicUser(updated);
}
