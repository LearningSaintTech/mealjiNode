import { toAbout } from "./kitchen.about.js";

export function toKitchen(kitchen) {
  return {
    kitchenId: String(kitchen._id),
    name: kitchen.name,
    contactName: kitchen.contactName,
    countryCode: kitchen.countryCode,
    phoneNumber: kitchen.phoneNumber,
    addressLine: kitchen.addressLine,
    area: kitchen.area ?? null,
    city: kitchen.city,
    state: kitchen.state ?? null,
    postalCode: kitchen.postalCode ?? null,
    latitude: kitchen.latitude ?? null,
    longitude: kitchen.longitude ?? null,
    serviceRadiusKm: kitchen.serviceRadiusKm,
    opensAt: kitchen.opensAt,
    closesAt: kitchen.closesAt,
    serviceNote: kitchen.serviceNote || "",
    status: kitchen.status,
    acceptingOrders: Boolean(kitchen.acceptingOrders),
    userId: kitchen.user ? String(kitchen.user) : null,
    weeklyHours: (kitchen.weeklyHours || []).map((day) => ({ weekday: day.weekday, closed: Boolean(day.closed), opensAt: day.opensAt ?? null, closesAt: day.closesAt ?? null })),
    closures: (kitchen.closures || []).map((item) => ({ date: item.date, reason: item.reason || "" })),
    billingEntityId: kitchen.billingEntity ? String(kitchen.billingEntity._id || kitchen.billingEntity) : null,
    about: toAbout(kitchen.about || {}),
    ratingAvg: kitchen.ratingAvg || 0,
    ratingCount: kitchen.ratingCount || 0,
    createdAt: kitchen.createdAt,
    updatedAt: kitchen.updatedAt,
  };
}
