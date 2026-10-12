// The Veg / All toggle. The customer's saved preference (`preferences.vegOnly`,
// changed by the toggle via PATCH /users/me/preferences) applies on every list;
// an explicit `?veg=true|false` on a request overrides it for that call only.
export function vegOnlyFor(req) {
  const value = req.query?.veg;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return Boolean(req.auth?.user?.preferences?.vegOnly);
}

/** Express middleware: sets req.vegOnly for signed-in requests. */
export function vegMode(req, res, next) {
  if (req.auth) req.vegOnly = vegOnlyFor(req);
  next();
}

/** Keeps only veg dishes when veg mode is on (lists the filters do not cover). */
export const vegFilter = (vegOnly, dishes) => (vegOnly ? dishes.filter((dish) => dish.isVeg) : dishes);
