// Personalisation and media rules for notifications (pure: no database).

/**
 * Variables every message can use. `{{user.firstName}}` and `{{user.name}}` are
 * always filled; the rest are read from the customer's profile and stats only
 * when a message uses them. `{{path | fallback}}` prints the fallback when empty.
 */
export const PERSONAL_VARIABLES = [
  { key: "user.firstName", label: "First name", example: "Priya", always: true },
  { key: "user.name", label: "Full name", example: "Priya Nair", always: true },
  { key: "user.phoneLast4", label: "Phone, last 4 digits", example: "3210" },
  { key: "user.city", label: "City", example: "Noida" },
  { key: "user.pointsBalance", label: "Reward points", example: "120" },
  { key: "user.referralCode", label: "Referral code", example: "PRIYA50" },
  { key: "user.ordersCount", label: "Orders delivered", example: "8" },
  { key: "user.daysSinceLastOrder", label: "Days since last order", example: "12" },
  { key: "user.tier", label: "Loyalty tier", example: "Gold" },
  { key: "user.planCode", label: "Plus plan code", example: "STANDARD_MONTHLY" },
  { key: "user.isPlusMember", label: "Plus member (yes/no)", example: "yes" },
];

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/g;

/** Fills {{a.b}} and {{a.b | fallback}} from data; unknown paths render the fallback or empty. */
export function render(text, data = {}) {
  if (typeof text !== "string") return text;
  return text.replace(PLACEHOLDER, (match, path, fallback) => {
    const value = path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
    return value == null || value === "" ? (fallback ?? "") : String(value);
  }).replace(/\s+([.,!])/g, "$1").trim();
}

/** The placeholder paths used in some text (strings, or any nesting of objects and arrays). */
export function placeholders(value, found = new Set()) {
  if (typeof value === "string") for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
  else if (Array.isArray(value)) value.forEach((item) => placeholders(item, found));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => placeholders(item, found));
  return found;
}

const ALWAYS = new Set(PERSONAL_VARIABLES.filter((item) => item.always).map((item) => item.key));

/** Whether the content uses a profile variable that needs a database read. */
export function needsProfile(...contents) {
  const used = new Set();
  contents.forEach((content) => placeholders(content, used));
  return [...used].some((path) => path.startsWith("user.") && !ALWAYS.has(path));
}

export function firstName(name) {
  return name && name !== "User" ? name.split(" ")[0] : "there";
}

/** The `user` variables for one customer; `stats` (UserStats) is optional. */
export function userVariables(user, stats = null) {
  const vars = { name: user.name || "", firstName: firstName(user.name) };
  if (stats === false) return vars;
  return {
    ...vars,
    phoneLast4: user.phoneNumber ? String(user.phoneNumber).slice(-4) : "",
    // Stats keep cities in lower case for matching; messages print "Bengaluru".
    city: stats?.city ? String(stats.city).replace(/\b\w/g, (letter) => letter.toUpperCase()) : "",
    pointsBalance: user.pointsBalance ?? stats?.pointsBalance ?? 0,
    referralCode: user.referralCode || "",
    ordersCount: stats?.deliveredOrdersCount ?? 0,
    daysSinceLastOrder: stats?.daysSinceLastOrder ?? "",
    tier: stats?.tier || "",
    planCode: stats?.planCode || "",
    isPlusMember: stats?.isPlusMember ? "yes" : "no",
  };
}

// Ad-hoc text (broadcasts, ops messages) is itself a template: it may use the same variables.
export const AD_HOC_FIELDS = ["title", "body", "imageUrl", "deepLink", "ctaLabel"];

export function renderAdHoc(data, vars) {
  const out = { ...data };
  for (const key of AD_HOC_FIELDS) if (typeof out[key] === "string") out[key] = render(out[key], vars);
  return out;
}

/**
 * Pictures in notifications must be https links on MealJi's own hosts (uploads,
 * CDN, or LINK_HOSTS), so a message can never load an image from anywhere.
 */
export function mediaUrlProblem(url, allowedHosts = []) {
  if (url == null || url === "") return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return "Image link is not a valid URL";
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) return "Image link must start with https://";
  if (!/\.(jpe?g|png|webp|gif)$/i.test(parsed.pathname)) return "Image must be a JPG, PNG, WebP or GIF";
  if (allowedHosts.length && !allowedHosts.includes(parsed.hostname.toLowerCase())) return `Images must be uploaded to MealJi (${allowedHosts.join(", ")})`;
  return null;
}

/** Ten-digit Indian mobile numbers from a list or pasted text (CSV, lines, commas). */
export function cleanPhones(input) {
  const cells = Array.isArray(input) ? input : String(input || "").split(/[\r\n,;\t]+/);
  return [...new Set(cells.map((cell) => String(cell).replace(/\D/g, "")).map((digits) => (digits.length > 10 ? digits.slice(-10) : digits)).filter((digits) => /^[6-9]\d{9}$/.test(digits)))];
}
