export const DEFAULT_COUNTRY_CODE = "+91";

export function countryOrDefault(countryCode) {
  return countryCode || DEFAULT_COUNTRY_CODE;
}

export function normalizeMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function maskPhone(phone) {
  const value = String(phone || "");
  if (value.length < 4) return "****";
  return `${value.slice(0, 2)}******${value.slice(-2)}`;
}
