const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

export function durationToSeconds(value) {
  const match = String(value).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  return Number(match[1]) * UNITS[match[2].toLowerCase()];
}
