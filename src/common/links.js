// Links the app opens from CMS content (banners, themes, in-app messages):
// the app's own scheme or an https page. javascript:, data:, http: and other
// schemes are refused so a CMS edit can never push a harmful link to users.
const APP_LINK = /^mealji:\/\/[\w\-./?=&%#:+@,~]*$/i;
const WEB_LINK = /^https:\/\/[^\s<>"]+$/i;

export function isSafeLink(value) {
  if (value == null || value === "") return true;
  const text = String(value).trim();
  return text.length <= 300 && (APP_LINK.test(text) || WEB_LINK.test(text));
}

/** Pushes a field error when the link is not allowed; returns the trimmed link or null. */
export function cleanLink(value, field, errors) {
  if (value == null || String(value).trim() === "") return null;
  if (!isSafeLink(value)) {
    errors.push({ field, message: "Link must start with mealji:// or https://" });
    return null;
  }
  return String(value).trim();
}

/** A list of strings, or a field error. */
export function stringArray(value, field, errors, { max = 50 } = {}) {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) {
    errors.push({ field, message: `${field} must be a list of up to ${max} values` });
    return [];
  }
  return value;
}
