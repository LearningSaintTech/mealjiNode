import { validationResult } from "express-validator";
import { AppError } from "../errors/AppError.js";

// The customer's name for a field, used when a check has no message of its own
// (express-validator says "Invalid value"), so the app never shows that text.
const FIELD_LABELS = {
  name: "your name", email: "your email address", dob: "your date of birth", gender: "a gender",
  phone: "a 10-digit mobile number", phoneNumber: "a 10-digit mobile number", otp: "the 6-digit code",
  label: "an address type", customLabel: "an address name", recipientName: "the receiver's name",
  houseFlat: "your house / flat", street: "the street", locality: "the area", landmark: "the landmark",
  city: "your city", state: "your state", pincode: "a 6-digit pincode", latitude: "your location", longitude: "your location",
  code: "a valid code", lineId: "a cart item", dishId: "a dish", comboId: "a combo", portionId: "a portion", optionIds: "your options",
  qty: "a quantity", tipPaise: "a tip amount", addressId: "an address", deliveryMode: "delivery or pickup",
  scheduledFor: "one of the delivery times shown", paymentMethod: "a payment method", usePoints: "yes or no",
  foodRating: "1 to 5 stars for the food", deliveryRating: "1 to 5 stars for the delivery", tags: "your feedback tags", comment: "a shorter comment",
  reason: "a reason", category: "a category", issueType: "an issue type", body: "your message", rating: "1 to 5 stars", attachments: "up to 5 files",
  page: "a page number", limit: "a page size", q: "what to search for", sort: "a sort option", cuisine: "a cuisine",
  slot: "a meal time", quick: "a filter", period: "a period", chip: "a filter", minPricePaise: "a price", maxPricePaise: "a price",
  planCode: "a plan", kitchenId: "a kitchen", categoryId: "a category", veg: "Veg or All", vegOnly: "Veg or All", language: "a language",
  fcmToken: "this device", deviceId: "this device", platform: "android or ios",
};

function customerMessage(item) {
  if (item.msg && item.msg !== "Invalid value") return item.msg;
  const field = String(item.path || "").split(/[.[]/)[0];
  const label = FIELD_LABELS[field];
  return label ? `Please enter ${label}` : "Please check what you entered";
}

export function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = result.array({ onlyFirstError: true }).map((item) => ({
    field: item.path,
    message: customerMessage(item),
  }));
  // The first problem is the main message, so the app can show `message` as it is.
  next(new AppError(422, errors[0]?.message || "Please check what you entered", errors));
}
