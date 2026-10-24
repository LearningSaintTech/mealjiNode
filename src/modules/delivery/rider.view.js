import { maskPhone } from "../../common/phone.util.js";

/**
 * Rider card for the customer (order and meal tracking, socket events): name,
 * photo, “4.9 (1,240 deliveries)”, vehicle and how to call. A kitchen rider's
 * number is given while they are on the way; a partner rider is called through
 * the app ("Call rider", numbers hidden), so only their masked number is shown.
 */
export function riderCard(rider, { onTheWay = false } = {}) {
  if (!rider?.name) return null;
  const viaPartner = Boolean(rider.externalId || rider.phoneMasked);
  const deliveries = rider.deliveriesCount != null ? `${rider.deliveriesCount.toLocaleString("en-IN")} deliveries` : null;
  return {
    name: rider.name,
    photoUrl: rider.photoUrl || null,
    rating: rider.rating ?? null,
    deliveriesCount: rider.deliveriesCount ?? null,
    ratingLabel: rider.rating != null ? `${rider.rating.toFixed(1)}${deliveries ? ` (${deliveries})` : ""}` : deliveries,
    vehicleNumber: rider.vehicleNumber || null,
    vehicleType: rider.vehicleType || null,
    phoneMasked: rider.phoneMasked || (rider.phone ? maskPhone(rider.phone) : null),
    // Direct dialling (kitchen riders only); partner riders: POST …/call-rider.
    canCall: Boolean(onTheWay && !viaPartner && rider.phone),
    callNumber: onTheWay && !viaPartner && rider.phone ? `+91${rider.phone}` : null,
  };
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
const istTime = (date) => IST_TIME.format(new Date(date)).replace(/\bam\b/, "AM").replace(/\bpm\b/, "PM");

/**
 * Delivery part of a tracking screen (orders and meals alike): status, live
 * position and delivery code while the delivery is open, the partner's live ETA
 * (else `fallbackEta`), "Call rider" and a problem notice after a failed delivery.
 * `canCallRider` comes from the delivery service (it knows the providers).
 */
export function trackingFields(job, { fallbackEta = null, active = true, canCallRider = false } = {}) {
  const open = Boolean(job && ["booked", "assigned", "picked_up"].includes(job.status));
  const eta = active ? (open && job.eta ? job.eta : fallbackEta) : null;
  return {
    deliveryStatus: job?.status || null,
    deliverySubStatus: job?.providerSubStatus || null,
    deliveryProblem: job?.status === "failed" && job.pickedUpAt ? "We couldn't deliver this. Our team will contact you shortly." : null,
    location: open && job.lastLocation?.lat != null ? job.lastLocation : null,
    remainingDistanceM: open ? job.remainingDistanceM ?? null : null,
    trackingUrl: job?.trackingUrl || null,
    // The customer gives this code to the rider at the door (while the delivery is open).
    deliveryOtp: open ? job.deliveryOtp || null : null,
    // "Call rider": the partner connects the customer to the rider (numbers hidden).
    canCallRider,
    estimatedDeliveryAt: eta,
    // “Estimated by 8:38 PM” · “Arriving in 12 mins”.
    arrivingAtLabel: eta ? istTime(eta) : null,
    etaMinutes: eta ? Math.max(0, Math.round((new Date(eta) - Date.now()) / 60_000)) : null,
  };
}
