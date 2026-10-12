export const DEFAULT_COUNTRY_CODE = "+91";

export function countryOrDefault(countryCode) {
  return countryCode || DEFAULT_COUNTRY_CODE;
}

export function normalizeMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** “98765 43210”, “+91 98765 43210”, “098765-43210” → “9876543210” (Indian mobile, 10 digits). */
export function indianMobileDigits(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

export function maskPhone(phone) {
  const value = String(phone || "");
  if (value.length < 4) return "****";
  return `${value.slice(0, 2)}******${value.slice(-2)}`;
}
