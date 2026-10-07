import assert from "node:assert/strict";
import { test } from "node:test";
import { splitGst, toPaise } from "../src/common/money.js";
import { istDateTime } from "../src/common/time.js";
import { foldVersions, versionChanges } from "../src/modules/settings/settings.resolver.js";
import { isSuspended, phoneChangePatch, reinstatePatch, suspendPatch, tokenRevoked } from "../src/modules/user/user.status.js";

const at = (iso) => new Date(iso);

test("a scheduled change never leaks into an earlier immediate change", () => {
  const versions = [
    { version: 1, effectiveFrom: at("2026-10-01T00:00:00Z"), patch: { minOrderPaise: 0 } },
    { version: 2, effectiveFrom: at("2026-12-01T00:00:00Z"), patch: { minOrderPaise: 50000 } },
    { version: 3, effectiveFrom: at("2026-10-10T00:00:00Z"), patch: { supportPhone: "1800" } },
  ];
  assert.deepEqual(foldVersions(versions, at("2026-10-15T00:00:00Z")), { minOrderPaise: 0, supportPhone: "1800" });
  assert.deepEqual(foldVersions(versions, at("2026-12-02T00:00:00Z")), { minOrderPaise: 50000, supportPhone: "1800" });
  assert.equal(foldVersions(versions, at("2026-09-01T00:00:00Z")), null);
});

test("cancelling one scheduled version leaves the others intact", () => {
  const versions = [
    { version: 1, effectiveFrom: at("2026-11-15T00:00:00Z"), patch: { acceptSlaMinutes: 4 } },
    { version: 2, effectiveFrom: at("2026-12-01T00:00:00Z"), patch: { minOrderPaise: 9900 } },
  ];
  const remaining = versions.filter((item) => item.version !== 2);
  assert.deepEqual(foldVersions(remaining, at("2026-12-05T00:00:00Z")), { acceptSlaMinutes: 4 });
});

test("legacy snapshot versions still fold and describe their changes", () => {
  const versions = [
    { version: 1, effectiveFrom: at("2026-10-01T00:00:00Z"), values: { a: 1, b: 2 } },
    { version: 2, effectiveFrom: at("2026-10-02T00:00:00Z"), values: { a: 1 } },
    { version: 3, effectiveFrom: at("2026-10-03T00:00:00Z"), patch: { c: 3 } },
  ];
  assert.deepEqual(foldVersions(versions, at("2026-10-04T00:00:00Z")), { a: 1, c: 3 });
  assert.deepEqual(versionChanges(versions[1], { a: 1, b: 2 }), { b: null });
  assert.deepEqual(versionChanges(versions[2], { a: 1 }), { c: 3 });
});

test("suspension survives sign-in and phone changes", () => {
  const invited = { isNumberVerified: false, isActive: false, suspendedAt: null };
  assert.equal(isSuspended(invited), false);
  const suspendedInvite = { ...invited, ...suspendPatch() };
  assert.equal(isSuspended(suspendedInvite), true);
  const afterPhoneChange = { ...suspendedInvite, ...phoneChangePatch() };
  assert.equal(isSuspended(afterPhoneChange), true, "phone change must not lift a suspension");
  const legacy = { isNumberVerified: true, isActive: false, suspendedAt: null };
  assert.equal(isSuspended(legacy), true);
  assert.deepEqual(reinstatePatch(invited), { suspendedAt: null, isActive: false });
  assert.deepEqual(reinstatePatch({ isNumberVerified: true }), { suspendedAt: null, isActive: true });
});

test("tokens issued before a revocation are rejected", () => {
  const revokedAt = new Date("2026-10-06T12:00:00Z");
  const user = { sessionsRevokedAt: revokedAt };
  assert.equal(tokenRevoked(user, Math.floor(revokedAt.getTime() / 1000) - 60), true);
  assert.equal(tokenRevoked(user, Math.floor(revokedAt.getTime() / 1000) + 5), false);
  assert.equal(tokenRevoked({}, 123), false);
});

test("rupee text converts to paise exactly", () => {
  assert.equal(toPaise("1.005"), 101);
  assert.equal(toPaise("0.285"), 29);
  assert.equal(toPaise(0.285), 29);
  assert.equal(toPaise("99"), 9900);
  assert.throws(() => toPaise("-5"));
  assert.throws(() => toPaise("abc"));
});

test("CGST and SGST are equal halves", () => {
  for (const amount of [101, 999, 12_345]) {
    const gst = splitGst(amount, 5);
    assert.equal(gst.cgst, gst.sgst);
    assert.equal(gst.total, gst.cgst + gst.sgst);
  }
});

test("impossible calendar dates are rejected", () => {
  assert.throws(() => istDateTime("2026-02-30", "10:00"));
  assert.throws(() => istDateTime("2026-13-01", "10:00"));
  assert.equal(istDateTime("2028-02-29", "00:00").toISOString(), "2028-02-28T18:30:00.000Z");
});
