import mongoose from "mongoose";
import { Router } from "express";
import { body, param, query } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { memoCache } from "../../common/memoCache.js";
import { accountLimiter } from "../../infrastructure/rateLimit.js";
import { storeGetOptional, storeSet } from "../../infrastructure/redisStore.js";
import { customerCombos, isOrderable, kitchenMenu, markFavorites, popularDishes, toDish } from "../catalog/catalog.service.js";
import { registerReport } from "../report/report.registry.js";
import { resolveCustomerKitchen } from "../serviceability/serviceability.service.js";

// ------------------------------------------------------------------ models

const searchLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    kitchen: { type: mongoose.Schema.Types.ObjectId, ref: "Kitchen", default: null },
    query: { type: String, required: true },
    normalized: { type: String, required: true },
    results: { type: Number, default: 0 },
    clickedDish: { type: mongoose.Schema.Types.ObjectId, default: null },
    hiddenFromRecent: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
searchLogSchema.index({ user: 1, createdAt: -1 });
searchLogSchema.index({ normalized: 1, createdAt: -1 });
searchLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 86_400 });
export const SearchLog = mongoose.model("SearchLog", searchLogSchema);

// Admin-managed synonyms: "biryani" ~ "biriyani", "paneer" ~ "cottage cheese".
const synonymSchema = new mongoose.Schema({ term: { type: String, required: true, unique: true, lowercase: true, trim: true }, synonyms: { type: [String], default: [] } }, { timestamps: true });
export const SearchSynonym = mongoose.model("SearchSynonym", synonymSchema);

// ------------------------------------------------------------------ search

const normalize = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

async function synonymMap() {
  const cached = await storeGetOptional("search:synonyms");
  if (cached.ok && cached.value) return JSON.parse(cached.value);
  const rows = await SearchSynonym.find().lean();
  const map = {};
  for (const row of rows) {
    const group = [row.term, ...row.synonyms].map(normalize).filter(Boolean);
    for (const word of group) map[word] = [...new Set([...(map[word] || []), ...group])];
  }
  await storeSet("search:synonyms", JSON.stringify(map), 300).catch(() => {});
  return map;
}

// One typo in a longer word still matches: one letter added, missing or wrong
// ("biriyani"), or two neighbouring letters swapped ("briyani").
function swapped(a, b) {
  if (a.length !== b.length) return false;
  const diff = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

function nearly(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  if (swapped(a, b)) return true;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function score(dish, terms) {
  const name = normalize(dish.name);
  const words = name.split(" ");
  const haystack = `${name} ${(dish.tags || []).join(" ")} ${normalize(dish.cuisine)} ${normalize(dish.description)}`;
  let total = 0;
  for (const variants of terms) {
    let best = 0;
    for (const term of variants) {
      if (name.startsWith(term)) best = Math.max(best, 10);
      else if (words.some((word) => word.startsWith(term))) best = Math.max(best, 8);
      else if (haystack.includes(term)) best = Math.max(best, 4);
      else if (words.some((word) => nearly(word, term))) best = Math.max(best, 3);
    }
    if (!best) return 0;
    total += best;
  }
  return total + (dish.isBestseller ? 1 : 0) + Math.min(2, (dish.orderCount || 0) / 100);
}

async function runSearch({ q, kitchenId, veg }) {
  const synonyms = await synonymMap();
  const terms = normalize(q).split(" ").filter(Boolean).slice(0, 6).map((word) => synonyms[word] || [word]);
  const menu = await kitchenMenu(kitchenId);
  let dishes = menu.rawDishes.map((dish) => ({ dish, score: score(dish, terms) })).filter((row) => row.score > 0);
  if (veg === true || veg === "true") dishes = dishes.filter((row) => row.dish.isVeg !== false);
  dishes.sort((a, b) => Number(isOrderable(b.dish)) - Number(isOrderable(a.dish)) || b.score - a.score);
  const combos = (await customerCombos(kitchenId)).filter((combo) => terms.every((variants) => variants.some((term) => normalize(combo.title).includes(term) || combo.items.some((item) => normalize(item.name).includes(term)))));
  const categories = menu.categories.filter((category) => terms.some((variants) => variants.some((term) => normalize(category.name).includes(term))));
  return { dishes: dishes.slice(0, 40).map((row) => toDish(row.dish)), combos: combos.slice(0, 10), categories };
}

/** “Try these instead” and “Popular right now” for a search with no results. */
async function zeroResultHelp(kitchenId, userId) {
  const popular = await markFavorites(userId, await popularDishes(kitchenId, 6));
  const menu = await kitchenMenu(kitchenId);
  const suggestions = [...new Set([...popular.map((dish) => dish.name), ...menu.categories.map((category) => category.name)])].slice(0, 6);
  return { suggestions, popular };
}

// Typing “p”, “pa”, “pan”… is one search: a query that extends (or shortens) the
// user's search from the last minute replaces it instead of adding a new row.
const TYPING_WINDOW_MS = 60_000;
async function logSearch({ userId, kitchenId, q, results }) {
  const normalized = normalize(q);
  const last = await SearchLog.findOne({ user: userId, createdAt: { $gte: new Date(Date.now() - TYPING_WINDOW_MS) } }).sort({ createdAt: -1 });
  if (last && !last.clickedDish && (normalized.startsWith(last.normalized) || last.normalized.startsWith(normalized))) {
    last.query = q.slice(0, 60);
    last.normalized = normalized;
    last.results = results;
    last.kitchen = kitchenId;
    await last.save();
    return last;
  }
  return SearchLog.create({ user: userId, kitchen: kitchenId, query: q.slice(0, 60), normalized, results });
}

// ------------------------------------------------------------------ routes

const customer = Router();
customer.use(authFor(["/search"], authMiddleware));
customer.get(
  "/search",
  accountLimiter("search", { limit: 120, windowSec: 60 }),
  query("q").isString().withMessage("Type what to search for").bail().trim().isLength({ min: 1, max: 60 }).withMessage("Search 1 to 60 characters"),
  query("kitchenId").optional({ values: "falsy" }).isMongoId().withMessage("kitchenId is not valid"),
  query("latitude").optional().isFloat({ min: -90, max: 90 }).withMessage("latitude is not valid"),
  query("longitude").optional().isFloat({ min: -180, max: 180 }).withMessage("longitude is not valid"),
  query("veg").optional().isBoolean().withMessage("veg is true or false"),
  validate,
  asyncHandler(async (req, res) => {
    const { kitchen } = await resolveCustomerKitchen({
      kitchenId: req.query.kitchenId || null,
      latitude: req.query.latitude != null ? Number(req.query.latitude) : null,
      longitude: req.query.longitude != null ? Number(req.query.longitude) : null,
      userId: req.auth.userId, user: req.auth.user,
    });
    const kitchenId = String(kitchen._id);
    const result = await runSearch({ q: req.query.q, kitchenId, veg: req.query.veg });
    result.dishes = await markFavorites(req.auth.userId, result.dishes);
    const total = result.dishes.length + result.combos.length;
    const log = await logSearch({ userId: req.auth.userId, kitchenId: kitchen._id, q: req.query.q, results: total });
    // Nothing found: suggestions to tap and popular dishes, so the screen is never empty.
    const help = total ? { suggestions: [], popular: [] } : await zeroResultHelp(kitchenId, req.auth.userId);
    return ok(res, { query: req.query.q, searchId: String(log._id), total, dishCount: result.dishes.length, ...result, ...help }, "Search results.");
  }),
);
customer.post("/search/:id/click", idParam(), body("dishId").isMongoId().withMessage("dishId is not valid"), validate, asyncHandler(async (req, res) => {
  const updated = await SearchLog.updateOne({ _id: req.params.id, user: req.auth.userId }, { $set: { clickedDish: req.body.dishId } });
  if (!updated.matchedCount) throw new AppError(404, "Search not found");
  return ok(res, { tracked: true }, "Tracked.");
}));
customer.get("/search/recent", asyncHandler(async (req, res) => {
  const rows = await SearchLog.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(req.auth.userId), hiddenFromRecent: false } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$normalized", query: { $first: "$query" }, at: { $first: "$createdAt" } } },
    { $sort: { at: -1 } },
    { $limit: 10 },
  ]);
  return ok(res, rows.map((row) => ({ query: row.query, at: row.at })), "Recent searches.");
}));
customer.delete("/search/recent", asyncHandler(async (req, res) => {
  await SearchLog.updateMany({ user: req.auth.userId, hiddenFromRecent: false }, { $set: { hiddenFromRecent: true } });
  return ok(res, { cleared: true }, "Recent searches cleared.");
}));
// Remove one recent search (the ✕ on a row).
customer.delete("/search/recent/:query", param("query").isString().isLength({ min: 1, max: 60 }), validate, asyncHandler(async (req, res) => {
  await SearchLog.updateMany({ user: req.auth.userId, normalized: normalize(req.params.query), hiddenFromRecent: false }, { $set: { hiddenFromRecent: true } });
  return ok(res, { removed: true }, "Removed from recent searches.");
}));
// One computation at a time per instance when the 10-minute cache runs out.
const trendingOnce = memoCache(5_000);
customer.get("/search/trending", asyncHandler(async (req, res) => {
  const cached = await storeGetOptional("search:trending");
  if (cached.ok && cached.value) return ok(res, JSON.parse(cached.value), "Trending.");
  const rows = await trendingOnce.get("rows", () => SearchLog.aggregate([
    { $match: { createdAt: { $gte: new Date(Date.now() - 7 * 86_400_000) }, results: { $gt: 0 } } },
    { $group: { _id: "$normalized", query: { $first: "$query" }, searches: { $sum: 1 }, people: { $addToSet: "$user" } } },
    { $project: { query: 1, searches: 1, people: { $size: "$people" } } },
    { $match: { people: { $gte: 2 } } },
    { $sort: { people: -1, searches: -1 } },
    { $limit: 10 },
  ]));
  const data = rows.map((row) => ({ query: row.query, searches: row.searches }));
  // Too little search history (a new city or a quiet week): fill up with the
  // kitchen's best-selling dishes so the screen always has chips to tap.
  if (data.length < 6) {
    try {
      const { kitchen } = await resolveCustomerKitchen({ userId: req.auth.userId, user: req.auth.user });
      const seen = new Set(data.map((row) => normalize(row.query)));
      for (const dish of await popularDishes(String(kitchen._id), 10)) {
        if (data.length >= 6) break;
        if (!seen.has(normalize(dish.name))) data.push({ query: dish.name, searches: 0 });
      }
    } catch {
      // no serving kitchen: trending stays as it is
    }
    return ok(res, data, "Trending.");
  }
  await storeSet("search:trending", JSON.stringify(data), 600).catch(() => {});
  return ok(res, data, "Trending.");
}));

const admin = Router();
admin.use(authFor(["/search"], authMiddleware));
admin.get("/search/insights", authorize("reports.read"), query("days").optional().isInt({ min: 1, max: 90 }).toInt(), validate, asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - (req.query.days || 30) * 86_400_000);
  const group = (match) => SearchLog.aggregate([
    { $match: { createdAt: { $gte: since }, ...match } },
    { $group: { _id: "$normalized", query: { $first: "$query" }, searches: { $sum: 1 }, clicks: { $sum: { $cond: ["$clickedDish", 1, 0] } } } },
    { $sort: { searches: -1 } },
    { $limit: 30 },
  ]);
  const [top, zero] = await Promise.all([group({ results: { $gt: 0 } }), group({ results: 0 })]);
  const view = (rows) => rows.map((row) => ({ query: row.query, searches: row.searches, clicks: row.clicks, ctr: row.searches ? Math.round((row.clicks / row.searches) * 1000) / 1000 : 0 }));
  return ok(res, { top: view(top), zeroResults: view(zero) }, "Search insights.");
}));
admin.get("/search/synonyms", authorize("menu.manage"), asyncHandler(async (req, res) => ok(res, (await SearchSynonym.find().sort({ term: 1 }).lean()).map((row) => ({ synonymId: String(row._id), term: row.term, synonyms: row.synonyms })), "Synonyms.")));
admin.put("/search/synonyms", authorize("menu.manage"), body("term").isString().trim().isLength({ min: 2, max: 40 }), body("synonyms").isArray({ min: 1, max: 20 }), validate, asyncHandler(async (req, res) => {
  const row = await SearchSynonym.findOneAndUpdate({ term: req.body.term.toLowerCase() }, { $set: { synonyms: req.body.synonyms.map((item) => String(item).toLowerCase().trim()).filter(Boolean) } }, { upsert: true, new: true });
  await storeSet("search:synonyms", "", 1).catch(() => {});
  return ok(res, { synonymId: String(row._id), term: row.term, synonyms: row.synonyms }, "Synonyms saved.");
}));
admin.delete("/search/synonyms/:id", authorize("menu.manage"), idParam(), validate, asyncHandler(async (req, res) => {
  const row = await SearchSynonym.findByIdAndDelete(req.params.id);
  if (!row) throw new AppError(404, "Not found");
  await storeSet("search:synonyms", "", 1).catch(() => {});
  return ok(res, { deleted: true }, "Deleted.");
}));

registerReport({
  key: "search_terms",
  title: "Search terms",
  category: "Product",
  description: "Top and zero-result searches with click-through.",
  permission: "reports.read",
  filters: ["dateRange"],
  columns: [
    { key: "query", label: "Search", type: "text" },
    { key: "searches", label: "Searches", type: "number" },
    { key: "people", label: "People", type: "number" },
    { key: "zeroResults", label: "Zero results", type: "number" },
    { key: "ctr", label: "Click-through", type: "percent" },
  ],
  async run(filters, paging) {
    const [result] = await SearchLog.aggregate([
      { $match: { createdAt: { $gte: filters.from, $lte: filters.to } } },
      { $group: { _id: "$normalized", query: { $first: "$query" }, searches: { $sum: 1 }, people: { $addToSet: "$user" }, zeroResults: { $sum: { $cond: [{ $eq: ["$results", 0] }, 1, 0] } }, clicks: { $sum: { $cond: ["$clickedDish", 1, 0] } } } },
      { $project: { _id: 0, query: 1, searches: 1, people: { $size: "$people" }, zeroResults: 1, ctr: { $round: [{ $divide: ["$clicks", "$searches"] }, 3] } } },
      { $sort: { searches: -1 } },
      { $facet: { rows: paging.all ? [{ $skip: 0 }] : [{ $skip: paging.skip }, { $limit: paging.limit }], total: [{ $count: "n" }] } },
    ]);
    return { rows: result.rows, total: result.total[0]?.n || 0 };
  },
});

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, customer);
  app.use("/api/v1/admin", recordMountPath, admin);
}

