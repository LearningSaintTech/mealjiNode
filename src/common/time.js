// Business time is India Standard Time. India has no daylight saving, so a fixed
// +05:30 offset is exact. Store instants as UTC Dates; use these helpers for
// "today", slots, cutoffs, quiet hours and report days.

export const BUSINESS_TIMEZONE = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

// Calendar fields of an instant as seen in IST.
export function istParts(date = new Date()) {
  const shifted = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

export function istDateKey(date = new Date()) {
  return istParts(date).dateKey;
}

export function parseHhmm(value) {
  const match = HHMM.exec(String(value || ""));
  if (!match) throw new TypeError(`Invalid time "${value}", expected HH:mm`);
  return Number(match[1]) * 60 + Number(match[2]);
}

// The UTC instant for a wall-clock time on an IST calendar day.
export function istDateTime(dateKey, hhmm = "00:00") {
  const match = DATE_KEY.exec(String(dateKey || ""));
  if (!match) throw new TypeError(`Invalid date "${dateKey}", expected YYYY-MM-DD`);
  const minutes = parseHhmm(hhmm);
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const check = new Date(utcMidnight);
  if (check.getUTCMonth() + 1 !== Number(match[2]) || check.getUTCDate() !== Number(match[3])) {
    throw new TypeError(`Invalid date "${dateKey}"`);
  }
  return new Date(utcMidnight + minutes * 60 * 1000 - IST_OFFSET_MS);
}

export function startOfIstDay(date = new Date()) {
  return istDateTime(istDateKey(date), "00:00");
}

export function addIstDays(dateKey, days) {
  const start = istDateTime(dateKey, "00:00");
  return istDateKey(new Date(start.getTime() + days * DAY_MS));
}

// True when the instant's IST time is inside [start, end). Windows may wrap past
// midnight (e.g. 21:00–09:00 quiet hours).
export function isWithinIstWindow(date, start, end) {
  const now = istParts(date);
  const current = now.hour * 60 + now.minute;
  const from = parseHhmm(start);
  const to = parseHhmm(end);
  if (from === to) return false;
  return from < to ? current >= from && current < to : current >= from || current < to;
}
