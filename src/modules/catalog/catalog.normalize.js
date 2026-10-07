import crypto from "node:crypto";
import { AppError } from "../../common/errors/AppError.js";

// Validation and clean-up of menu input (pure). Throws a 422 with field errors.

const shortId = () => crypto.randomBytes(5).toString("hex");
const SLOTS = ["breakfast", "lunch", "dinner", "snacks"];
// Fields whose change counts as a "price change" for the approval policy.
export const PRICE_FIELDS = ["pricePaise", "originalPricePaise", "packagingPaise", "portions", "customizationGroups", "mealUpgrade"];

function fail(errors) {
  if (errors.length) throw new AppError(422, "Validation failed", errors);
}

const isMoney = (value) => Number.isInteger(value) && value >= 0 && value <= 100_000_00;
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : null);

function stringList(value, { max = 10, maxLength = 60 } = {}) {
  if (!Array.isArray(value)) return null;
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().slice(0, maxLength)).slice(0, max);
}

function portions(value, errors) {
  if (!Array.isArray(value)) return errors.push({ field: "portions", message: "portions must be a list" });
  if (value.length > 6) errors.push({ field: "portions", message: "Up to 6 portions" });
  const out = value.map((item, index) => {
    if (!item || !str(item.label, 40)) errors.push({ field: `portions[${index}].label`, message: "Portion label is required" });
    if (!isMoney(item?.pricePaise)) errors.push({ field: `portions[${index}].pricePaise`, message: "Portion price must be paise" });
    return { portionId: item?.portionId || shortId(), label: str(item?.label, 40), pricePaise: item?.pricePaise, isDefault: Boolean(item?.isDefault) };
  });
  if (out.length && !out.some((item) => item.isDefault)) out[0].isDefault = true;
  return out;
}

function groups(value, errors) {
  if (!Array.isArray(value)) return errors.push({ field: "customizationGroups", message: "customizationGroups must be a list" });
  if (value.length > 8) errors.push({ field: "customizationGroups", message: "Up to 8 option groups" });
  return value.map((group, index) => {
    const name = str(group?.name, 60);
    if (!name) errors.push({ field: `customizationGroups[${index}].name`, message: "Group name is required" });
    const options = Array.isArray(group?.options) ? group.options : [];
    if (!options.length) errors.push({ field: `customizationGroups[${index}].options`, message: "Add at least one option" });
    const minSelect = Number.isInteger(group?.minSelect) ? group.minSelect : 0;
    const maxSelect = Number.isInteger(group?.maxSelect) ? group.maxSelect : 1;
    if (minSelect < 0 || maxSelect < 1 || minSelect > maxSelect || maxSelect > Math.max(1, options.length)) {
      errors.push({ field: `customizationGroups[${index}]`, message: "Min/max selections do not fit the options" });
    }
    return {
      groupId: group?.groupId || shortId(),
      name,
      minSelect,
      maxSelect,
      options: options.slice(0, 20).map((option, optionIndex) => {
        if (!str(option?.name, 60)) errors.push({ field: `customizationGroups[${index}].options[${optionIndex}].name`, message: "Option name is required" });
        if (option?.pricePaise != null && !isMoney(option.pricePaise)) errors.push({ field: `customizationGroups[${index}].options[${optionIndex}].pricePaise`, message: "Option price must be paise" });
        return {
          optionId: option?.optionId || shortId(),
          name: str(option?.name, 60),
          pricePaise: option?.pricePaise || 0,
          isVeg: option?.isVeg !== false,
          isAvailable: option?.isAvailable !== false,
        };
      }),
    };
  });
}

/**
 * Cleans dish input. `partial` allows a subset (updates). `kitchenDish`
 * enables the price and availability fields that only kitchen dishes have.
 */
export function normalizeDish(input, { partial = false, kitchenDish = true, maxImages = 5 } = {}) {
  const errors = [];
  const out = {};
  const present = (key) => input[key] !== undefined;

  if (!partial || present("name")) {
    out.name = str(input.name, 100);
    if (!out.name) errors.push({ field: "name", message: "Dish name is required" });
  }
  for (const [key, max] of [["description", 600], ["story", 1500], ["cuisine", 40], ["badge", 30]]) {
    if (present(key)) out[key] = input[key] == null ? (key === "description" || key === "story" ? "" : null) : str(input[key], max);
  }
  if (present("images")) {
    const images = stringList(input.images, { max: maxImages, maxLength: 500 });
    if (!images) errors.push({ field: "images", message: "images must be a list of URLs" });
    else if (input.images.length > maxImages) errors.push({ field: "images", message: `Up to ${maxImages} images` });
    else out.images = images;
  }
  for (const key of ["isVeg", "isBestseller", "isAvailable", "isActive"]) {
    if (present(key)) out[key] = Boolean(input[key]);
  }
  if (present("spicyLevel")) {
    if (!Number.isInteger(input.spicyLevel) || input.spicyLevel < 0 || input.spicyLevel > 3) errors.push({ field: "spicyLevel", message: "spicyLevel is 0 to 3" });
    else out.spicyLevel = input.spicyLevel;
  }
  for (const key of ["calories", "servesCount", "preparationMinutes", "sortOrder", "dailyStockLimit"]) {
    if (!present(key)) continue;
    if (input[key] == null && key === "calories") {
      out[key] = null;
      continue;
    }
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 100_000) errors.push({ field: key, message: `${key} must be a whole number` });
    else out[key] = input[key];
  }
  if (present("highlights")) out.highlights = stringList(input.highlights, { max: 8, maxLength: 80 }) || [];
  if (present("tags")) out.tags = (stringList(input.tags, { max: 12, maxLength: 30 }) || []).map((tag) => tag.toLowerCase());
  if (present("portions")) out.portions = portions(input.portions, errors);
  if (present("customizationGroups")) out.customizationGroups = groups(input.customizationGroups, errors);
  if (present("mealUpgrade")) {
    const upgrade = input.mealUpgrade;
    if (upgrade == null || (!upgrade.label && upgrade.pricePaise == null)) out.mealUpgrade = { label: null, description: null, pricePaise: null };
    else {
      if (!str(upgrade.label, 60) || !isMoney(upgrade.pricePaise)) errors.push({ field: "mealUpgrade", message: "Meal upgrade needs a label and a price" });
      out.mealUpgrade = { label: str(upgrade.label, 60), description: str(upgrade.description, 200), pricePaise: upgrade.pricePaise };
    }
  }

  if (kitchenDish) {
    if (!partial || present("pricePaise")) {
      if (!isMoney(input.pricePaise)) errors.push({ field: "pricePaise", message: "Price must be a whole number of paise" });
      else out.pricePaise = input.pricePaise;
    }
    if (present("originalPricePaise")) {
      if (input.originalPricePaise != null && !isMoney(input.originalPricePaise)) errors.push({ field: "originalPricePaise", message: "MRP must be paise" });
      else out.originalPricePaise = input.originalPricePaise ?? null;
    }
    if (present("packagingPaise")) {
      if (!isMoney(input.packagingPaise)) errors.push({ field: "packagingPaise", message: "Packaging must be paise" });
      else out.packagingPaise = input.packagingPaise;
    }
    if (present("availableSlots")) {
      const slots = stringList(input.availableSlots, { max: 4 }) || [];
      if (slots.some((slot) => !SLOTS.includes(slot))) errors.push({ field: "availableSlots", message: `Slots: ${SLOTS.join(", ")}` });
      else out.availableSlots = slots;
    }
    if (present("availableDays")) {
      if (!Array.isArray(input.availableDays) || input.availableDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        errors.push({ field: "availableDays", message: "Days are 0 (Sunday) to 6" });
      } else out.availableDays = [...new Set(input.availableDays)];
    }
  } else if (present("suggestedPricePaise")) {
    out.suggestedPricePaise = input.suggestedPricePaise == null ? null : input.suggestedPricePaise;
  }
  fail(errors);
  return out;
}

export function normalizeCategory(input, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = str(input.name, 60);
    if (!out.name) errors.push({ field: "name", message: "Category name is required" });
  }
  for (const [key, max] of [["icon", 60], ["subtitle", 120], ["imageUrl", 500]]) {
    if (input[key] !== undefined) out[key] = input[key] == null ? null : str(input[key], max);
  }
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder)) errors.push({ field: "sortOrder", message: "sortOrder must be a whole number" });
    else out.sortOrder = input.sortOrder;
  }
  if (input.isActive !== undefined) out.isActive = Boolean(input.isActive);
  fail(errors);
  return out;
}

export function normalizeCombo(input, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || input.title !== undefined) {
    out.title = str(input.title, 100);
    if (!out.title) errors.push({ field: "title", message: "Title is required" });
  }
  for (const [key, max] of [["subtitle", 200], ["imageUrl", 500], ["badge", 30]]) {
    if (input[key] !== undefined) out[key] = input[key] == null ? null : str(input[key], max);
  }
  if (!partial || input.pricePaise !== undefined) {
    if (!isMoney(input.pricePaise)) errors.push({ field: "pricePaise", message: "Price must be paise" });
    else out.pricePaise = input.pricePaise;
  }
  if (input.originalPricePaise !== undefined) out.originalPricePaise = input.originalPricePaise ?? null;
  if (input.serves !== undefined) out.serves = Number.isInteger(input.serves) && input.serves > 0 ? input.serves : 1;
  if (!partial || input.items !== undefined) {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 12) errors.push({ field: "items", message: "A combo has 1 to 12 dishes" });
    else out.items = input.items.map((item) => ({ dish: item.dishId, qty: Number.isInteger(item.qty) && item.qty > 0 ? item.qty : 1 }));
  }
  if (input.filterTags !== undefined) out.filterTags = stringList(input.filterTags, { max: 8, maxLength: 30 }) || [];
  for (const key of ["isSignature", "isAvailable", "isActive"]) {
    if (input[key] !== undefined) out[key] = Boolean(input[key]);
  }
  if (input.sortOrder !== undefined && Number.isInteger(input.sortOrder)) out.sortOrder = input.sortOrder;
  fail(errors);
  return out;
}

/** The fields of a change that need approval under the menu policy. */
export function gatedFields(policy, changes, { creating = false } = {}) {
  if (policy === "all") return Object.keys(changes);
  if (policy === "new_items") return creating ? Object.keys(changes) : [];
  if (policy === "price_changes") return creating ? [] : Object.keys(changes).filter((key) => PRICE_FIELDS.includes(key));
  return [];
}
