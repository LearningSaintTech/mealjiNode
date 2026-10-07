// All amounts are integer paise. Clients format for display; the server never
// stores or returns rupee floats.

export function isPaise(value) {
  return Number.isInteger(value) && value >= 0;
}

export function assertPaise(value, field = "amount") {
  if (!isPaise(value)) {
    throw new TypeError(`${field} must be a non-negative integer number of paise`);
  }
  return value;
}

// Parses the decimal text exactly (no float rounding: "1.005" is 101 paise,
// rounded half up on the third decimal). Negative amounts are rejected.
export function toPaise(rupees) {
  const text = typeof rupees === "number" ? rupees.toFixed(3) : String(rupees ?? "").trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError("Amount must be a non-negative number");
  const fraction = (match[2] || "").padEnd(3, "0");
  const paise = Number(match[1]) * 100 + Number(fraction.slice(0, 2));
  return Number(fraction[2]) >= 5 ? paise + 1 : paise;
}

export function fromPaise(paise) {
  return Number(paise) / 100;
}

// Percent of an amount, rounded half up to the nearest paisa.
export function percentOf(amountPaise, percent) {
  return Math.round((amountPaise * Number(percent)) / 100);
}

// GST on a taxable amount. Intra-state supply charges CGST and SGST at half the
// rate each, computed separately so both invoice lines are equal; the total is
// their sum. Inter-state supply charges IGST at the full rate.
export function splitGst(taxablePaise, ratePercent, { interState = false } = {}) {
  if (interState) {
    const igst = percentOf(taxablePaise, ratePercent);
    return { cgst: 0, sgst: 0, igst, total: igst };
  }
  const half = percentOf(taxablePaise, Number(ratePercent) / 2);
  return { cgst: half, sgst: half, igst: 0, total: half * 2 };
}

export function sumPaise(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}
