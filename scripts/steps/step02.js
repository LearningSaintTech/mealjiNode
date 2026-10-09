// Step 02 · Sign in — Login and OTP screens.
import { Client, createSuite, DEMO, env, newCustomer } from "./harness.js";

export default async function step02(ctx) {
  const s = createSuite("02", "Sign in");
  const app = new Client("step02-device-001");

  await s.run("02-01", "Short or wrong phone is refused with a field message", "Login: phone input", async () => {
    const res = await app.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: "12345" });
    return { ok: res.status === 422 && res.errors?.some((e) => e.field === "phoneNumber"), detail: `${res.status} ${JSON.stringify(res.errors)}` };
  });
  await s.run("02-02", "An email in the phone box gets a clear message", "Login placeholder says “Phone number or email”; sign-in is by mobile OTP", async () => {
    const res = await app.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: "rahul@example.com" });
    const message = (res.errors || []).map((e) => e.message).join(" ");
    return { ok: res.status === 422 && /mobile/i.test(message), detail: `${res.status} ${message}` };
  });
  await s.run("02-03", "Phone with spaces or a +91 prefix still works", "Users type “90000 00031” or “+91 9000000031”", async () => {
    const res = await app.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: "+91 90000 00031" });
    return { ok: res.status === 201 && res.data?.userId, detail: `${res.status} ${res.message}` };
  });

  const nc = await newCustomer(ctx);
  const sent = nc.login;
  await s.run("02-04", "Send OTP returns what the OTP screen needs", "OTP screen: 6 boxes, 30-second resend timer", () => ({
    ok: sent.status === 201 && sent.data?.userId && sent.data.otpLength === 6 && sent.data.resendAfterSec === 30 && sent.data.expiresInSec > 0,
    detail: `${sent.status} otpLength ${sent.data?.otpLength} resendAfterSec ${sent.data?.resendAfterSec} expiresInSec ${sent.data?.expiresInSec}`,
  }));
  await s.run("02-05", "Resend before the timer ends is refused", "OTP screen: resend only after the countdown", async () => {
    // A fresh, still-pending OTP (the new customer's was already used).
    const pending = await app.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: DEMO.otherCustomer });
    const res = await app.call("POST", "/auth/resend-otp", { userId: pending.data?.userId });
    return { ok: res.status === 429, detail: `${res.status} ${res.message}` };
  });
  await s.run("02-06", "Wrong code is refused", "OTP screen: wrong OTP message", async () => {
    const again = await app.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: DEMO.otherCustomer });
    const res = await app.call("POST", "/auth/verify-otp", { userId: again.data?.userId, otp: env.fixedOtp === "000000" ? "111111" : "000000" });
    return { ok: res.status === 400 && /invalid/i.test(res.message), detail: `${res.status} ${res.message}` };
  });
  await s.run("02-07", "Verify needs the device id", "Sessions are per device", async () => {
    const again = await app.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: DEMO.otherCustomer });
    const res = await new Client(null).call("POST", "/auth/verify-otp", { userId: again.data?.userId, otp: env.fixedOtp });
    return { ok: res.status === 400, detail: `${res.status} ${res.message}` };
  });
  const verify = nc.verify;
  await s.run("02-08", "New customer: tokens + “new user, profile incomplete”", "After OTP a new customer goes to Profile setup", () => ({
    ok: verify.status === 201 && verify.data?.accessToken && verify.data?.refreshToken && verify.data.expiresIn > 0 && verify.data.isNewUser === true && verify.data.profileComplete === false,
    detail: `${verify.status} isNewUser ${verify.data?.isNewUser} profileComplete ${verify.data?.profileComplete}`,
  }));

  const returning = new Client("step02-device-003");
  const back = await returning.signIn(DEMO.customer);
  const user = back.data?.user || {};
  await s.run("02-09", "Returning customer: not new, profile complete, location known", "Returning users skip Profile setup and Location", () => ({
    ok: back.data?.isNewUser === false && back.data?.profileComplete === true && Boolean(user.currentLocation),
    detail: `isNewUser ${back.data?.isNewUser} profileComplete ${back.data?.profileComplete} location ${user.currentLocation ? "yes" : "no"}`,
  }));
  await s.run("02-10", "Signed-in user carries name, phone, points, tier and avatar", "App user model: name, phone, points, tier, avatar", () => ({
    ok: Boolean(user.name && user.phoneNumber) && Number.isInteger(user.points) && "tier" in user && "avatarUrl" in user,
    detail: JSON.stringify({ name: user.name, points: user.points, tier: user.tier, avatarUrl: Boolean(user.avatarUrl) }),
  }));
  await s.run("02-11", "Who-am-I works with the token, not without", "App restores the session on launch", async () => {
    const me = await returning.call("GET", "/auth/me");
    const anon = await new Client("step02-device-004").call("GET", "/auth/me");
    return { ok: me.status === 200 && Boolean(me.data?.userId) && anon.status === 401, detail: `${me.status}/${anon.status}` };
  });
  await s.run("02-12", "Refresh gives a new pair; a junk token is refused", "Keep the user signed in for 60 days", async () => {
    const ok = await returning.call("POST", "/auth/refresh", { refreshToken: back.data?.refreshToken });
    const junk = await returning.call("POST", "/auth/refresh", { refreshToken: "junk" });
    if (ok.data?.accessToken) returning.headers.Authorization = `Bearer ${ok.data.accessToken}`;
    return { ok: [200, 201].includes(ok.status) && Boolean(ok.data?.refreshToken) && junk.status === 401, detail: `${ok.status}/${junk.status}` };
  });
  await s.run("02-13", "Logout ends the session", "Profile: Log out", async () => {
    const out = await returning.call("POST", "/auth/logout");
    const after = await returning.call("GET", "/auth/me");
    return { ok: out.status === 200 && after.status === 401, detail: `${out.status}/${after.status}` };
  });
  await s.run("02-14", "Changing letter case never skips sign-in", "Security: protected screens need a token", async () => {
    const statuses = [];
    for (const path of ["/AUTH/ME", "/Users/Me", "/SEARCH/TRENDING", "/Home"]) statuses.push((await new Client("step02-device-005").call("GET", path)).status);
    return { ok: statuses.every((status) => status === 401), detail: statuses.join(",") };
  });
  return s;
}
