import { isSuspended } from "./user.status.js";

export function toCurrentLocation(location) {
  if (!location?.locationText) return null;
  return {
    locationText: location.locationText,
    area: location.area ?? null,
    city: location.city ?? null,
    state: location.state ?? null,
    postalCode: location.postalCode ?? null,
    country: location.country ?? null,
    latitude: location.latitude,
    longitude: location.longitude,
    updatedAt: location.updatedAt ?? null,
  };
}

export function toPublicUser(user) {
  const permissions = (user.role?.permissions || []).map((permission) => permission.key).sort();
  const subscription = user.subscription || {};

  return {
    userId: String(user._id),
    name: user.name,
    countryCode: user.countryCode,
    phoneNumber: user.phoneNumber,
    role: user.role?.slug || null,
    kitchenId: user.kitchen ? String(user.kitchen._id || user.kitchen) : null,
    permissions,
    isActive: user.isActive,
    isNumberVerified: user.isNumberVerified,
    isSuspended: isSuspended(user),
    suspendedAt: user.suspendedAt ?? null,
    subscription: {
      planCode: subscription.planCode ?? null,
      status: subscription.status ?? "none",
      subscribedAt: subscription.subscribedAt ?? null,
      expiresAt: subscription.expiresAt ?? null,
    },
    currentLocation: toCurrentLocation(user.currentLocation),
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
    email: user.email ?? null,
    // What the app's user model shows right after sign-in.
    avatarUrl: user.avatarUrl ?? null,
    points: user.pointsBalance || 0,
    tier: user.tier ?? null,
    deletedAt: user.deletedAt ?? null,
  };
}

export function isProfileComplete(user) {
  return Boolean(user?.name && user.name !== "User");
}

// The customer's own profile (GET /users/me).
export function toProfile(doc) {
  const user = typeof doc?.toObject === "function" ? doc.toObject() : doc;
  const preferences = user.preferences || {};
  return {
    userId: String(user._id),
    name: user.name,
    countryCode: user.countryCode,
    phoneNumber: user.phoneNumber,
    email: user.email ?? null,
    emailVerified: Boolean(user.emailVerified),
    dob: user.dob ?? null,
    gender: user.gender ?? null,
    avatarUrl: user.avatarUrl ?? null,
    profileComplete: isProfileComplete(user),
    referralCode: user.referralCode ?? null,
    points: user.pointsBalance || 0,
    tier: user.tier ?? null,
    preferences: {
      language: preferences.language || "en",
      vegOnly: Boolean(preferences.vegOnly),
      channels: { push: true, whatsapp: false, email: true, sms: true, ...(preferences.channels || {}) },
      topics: { offers: true, rewards: true, account: true, ...(preferences.topics || {}) },
    },
    subscription: {
      planCode: user.subscription?.planCode ?? null,
      status: user.subscription?.status ?? "none",
      expiresAt: user.subscription?.expiresAt ?? null,
    },
    currentLocation: toCurrentLocation(user.currentLocation),
    createdAt: user.createdAt,
  };
}
