// Account state rules in one place.
//
// - Invited: never completed an OTP sign-in (isNumberVerified = false).
// - Suspended: `suspendedAt` is set. A sign-in never clears it, so suspending an
//   invited account, or changing a suspended person's phone, cannot be undone by
//   whoever holds the number. Older records marked only as "verified but
//   inactive" also count as suspended.
// - Active: verified and not suspended.

export function isSuspended(user) {
  return Boolean(user?.suspendedAt) || Boolean(user?.isNumberVerified && !user?.isActive);
}

export function suspendPatch(now = new Date()) {
  // Ending every session (sessionsRevokedAt) signs the person out everywhere.
  return { isActive: false, suspendedAt: now, sessionsRevokedAt: now };
}

export function reinstatePatch(user) {
  // An invited account stays inactive until its first OTP sign-in.
  return { suspendedAt: null, isActive: Boolean(user.isNumberVerified) };
}

// A new phone number belongs to whoever holds it now: it must be verified by
// OTP again, and sessions opened with the old number end.
export function phoneChangePatch(now = new Date()) {
  return { isNumberVerified: false, isActive: false, sessionsRevokedAt: now };
}

// True when a token issued at `iatSec` (JWT seconds) predates a revocation.
export function tokenRevoked(user, iatSec) {
  if (!user?.sessionsRevokedAt || !iatSec) return false;
  return iatSec * 1000 < new Date(user.sessionsRevokedAt).getTime() - 1000;
}
