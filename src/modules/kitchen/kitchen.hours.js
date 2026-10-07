import { addIstDays, istDateKey, istDateTime, istParts, parseHhmm } from "../../common/time.js";

// Pure opening-hours rules (IST), shared by serviceability, cart and ordering.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The hours that apply on one IST date: closed for a closure day, else the weekday's hours. */
export function hoursOn(kitchen, dateKey) {
  if ((kitchen.closures || []).some((item) => item.date === dateKey)) {
    const closure = kitchen.closures.find((item) => item.date === dateKey);
    return { closed: true, reason: closure?.reason || "Closed today" };
  }
  const weekday = istParts(istDateTime(dateKey, "12:00")).weekday;
  const day = (kitchen.weeklyHours || []).find((item) => item.weekday === weekday);
  if (day?.closed) return { closed: true, reason: "Closed on this day" };
  const opensAt = day?.opensAt && HHMM.test(day.opensAt) ? day.opensAt : kitchen.opensAt;
  const closesAt = day?.closesAt && HHMM.test(day.closesAt) ? day.closesAt : kitchen.closesAt;
  if (!HHMM.test(opensAt || "") || !HHMM.test(closesAt || "")) return { closed: true, reason: "Hours not set" };
  return { closed: false, opensAt, closesAt };
}

/**
 * Whether the kitchen is within its opening hours at `date`. Hours may cross
 * midnight (e.g. 18:00–02:00): the late part belongs to the previous day.
 */
export function isOpenAt(kitchen, date = new Date()) {
  const now = istParts(date);
  const minutes = now.hour * 60 + now.minute;
  const today = hoursOn(kitchen, now.dateKey);
  if (!today.closed) {
    const open = parseHhmm(today.opensAt);
    const close = parseHhmm(today.closesAt);
    if (open < close ? minutes >= open && minutes < close : minutes >= open) return true;
  }
  const yesterday = hoursOn(kitchen, addIstDays(now.dateKey, -1));
  if (!yesterday.closed) {
    const open = parseHhmm(yesterday.opensAt);
    const close = parseHhmm(yesterday.closesAt);
    if (open > close && minutes < close) return true;
  }
  return false;
}

/** The next instant the kitchen opens (within a week), or null. */
export function nextOpening(kitchen, date = new Date()) {
  const start = istDateKey(date);
  for (let offset = 0; offset < 8; offset += 1) {
    const dateKey = addIstDays(start, offset);
    const hours = hoursOn(kitchen, dateKey);
    if (hours.closed) continue;
    const at = istDateTime(dateKey, hours.opensAt);
    if (at > date) return at;
  }
  return null;
}

/** Live order state: can a customer order from this kitchen right now? */
export function orderingState(kitchen, date = new Date()) {
  if (!kitchen || kitchen.status !== "active") return { canOrder: false, reason: "kitchen_unavailable", message: "This kitchen is not taking orders" };
  if (!isOpenAt(kitchen, date)) {
    const next = nextOpening(kitchen, date);
    return { canOrder: false, reason: "closed", message: "The kitchen is closed right now", opensAt: next };
  }
  if (!kitchen.acceptingOrders) return { canOrder: false, reason: "paused", message: "The kitchen has paused orders for a while" };
  return { canOrder: true, reason: null, message: null };
}
