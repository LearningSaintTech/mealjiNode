// Step 03 · Profile setup — Profile setup and Edit profile screens (and the profile header).
import { Client, createSuite, DEMO, newCustomer } from "./harness.js";

// 1×1 white JPEG for the avatar upload.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

export default async function step03(ctx) {
  const s = createSuite("03", "Profile setup");
  const me = new Client("step03-device-001");
  await me.signIn(DEMO.customer);
  const before = await me.call("GET", "/users/me");
  const profile = before.data || {};

  await s.run("03-01", "Profile has everything the profile screens show", "Edit profile: name, phone, email, date of birth, gender, photo; header: points and tier", () => ({
    ok: before.status === 200 && profile.name && profile.phoneNumber && "email" in profile && "dob" in profile && "gender" in profile && "avatarUrl" in profile && Number.isInteger(profile.points) && "tier" in profile && typeof profile.profileComplete === "boolean",
    detail: JSON.stringify({ name: profile.name, points: profile.points, tier: profile.tier, profileComplete: profile.profileComplete }),
  }));
  await s.run("03-02", "Profile header counts come with the profile", "Profile header: orders, favourites, addresses, payment methods", () => ({
    ok: profile.stats && ["orders", "favorites", "addresses", "paymentMethods"].every((key) => Number.isInteger(profile.stats[key])),
    detail: JSON.stringify(profile.stats),
  }));
  await s.run("03-03", "Name shorter than 2 characters is refused", "Profile setup: “Please enter your full name (min 2 characters)”", async () => {
    const res = await me.call("PATCH", "/users/me", { name: "A" });
    return { ok: res.status === 422 && res.errors?.some((e) => e.field === "name"), detail: `${res.status} ${JSON.stringify(res.errors)}` };
  });
  await s.run("03-04", "Bad email and future birthday are refused", "Edit profile validation", async () => {
    const email = await me.call("PATCH", "/users/me", { email: "not-an-email" });
    const dob = await me.call("PATCH", "/users/me", { dob: "2999-01-01" });
    return { ok: email.status === 422 && dob.status === 422, detail: `${email.status}/${dob.status}` };
  });
  await s.run("03-05", "Gender as the app writes it (“Male”) is accepted", "Edit profile shows gender as “Male”", async () => {
    const res = await me.call("PATCH", "/users/me", { gender: "Male" });
    await me.call("PATCH", "/users/me", { gender: profile.gender ?? null });
    return { ok: res.status === 200 && res.data?.gender === "male", detail: `${res.status} ${res.data?.gender}` };
  });
  await s.run("03-06", "Saving name, email and birthday returns the updated profile", "Edit profile: Save changes", async () => {
    const res = await me.call("PATCH", "/users/me", { name: "Rahul Sharma", email: "rahul.sharma@example.com", dob: "1995-10-12" });
    const ok = res.status === 200 && res.data?.email === "rahul.sharma@example.com" && res.data?.dob?.startsWith("1995-10-12");
    await me.call("PATCH", "/users/me", { name: profile.name, email: profile.email ?? null, dob: profile.dob ? String(profile.dob).slice(0, 10) : null });
    return { ok, detail: `${res.status} ${res.data?.dob}` };
  });
  await s.run("03-07", "Photo upload: presign, upload, save, shows on the profile", "Edit profile: change photo", async () => {
    const presign = await me.call("POST", "/uploads/presign", { purpose: "avatar", contentType: "image/jpeg", size: JPEG.length });
    if (presign.status !== 200 && presign.status !== 201) return { ok: false, detail: `presign ${presign.status} ${presign.message}` };
    const put = await fetch(presign.data.uploadUrl, { method: "PUT", headers: presign.data.headers, body: JPEG });
    const save = await me.call("POST", "/users/me/avatar", { avatarUrl: presign.data.fileUrl });
    const after = await me.call("GET", "/users/me");
    const loads = (await fetch(after.data?.avatarUrl || "", { method: "HEAD" }).catch(() => ({ ok: false }))).ok;
    await me.call("POST", "/users/me/avatar", { avatarUrl: profile.avatarUrl }).catch(() => {});
    if (profile.avatarUrl) await me.call("PATCH", "/users/me", { avatarUrl: profile.avatarUrl });
    return { ok: put.ok && save.status === 200 && after.data?.avatarUrl === presign.data.fileUrl && loads, detail: `upload ${put.status}, save ${save.status}, loads ${loads}` };
  });
  await s.run("03-08", "Wrong photo type or size is refused", "Edit profile: only images, max 2 MB", async () => {
    const pdf = await me.call("POST", "/uploads/presign", { purpose: "avatar", contentType: "application/pdf", size: 1000 });
    const big = await me.call("POST", "/uploads/presign", { purpose: "avatar", contentType: "image/jpeg", size: 9 * 1024 * 1024 });
    return { ok: pdf.status === 422 && big.status === 422, detail: `${pdf.status}/${big.status}` };
  });
  await s.run("03-09", "Preferences save and come back", "Profile: veg-only and language", async () => {
    const prefs = await me.call("GET", "/users/me/preferences");
    const set = await me.call("PATCH", "/users/me/preferences", { vegOnly: !prefs.data?.vegOnly });
    const bad = await me.call("PATCH", "/users/me/preferences", { language: "fr" });
    await me.call("PATCH", "/users/me/preferences", { vegOnly: Boolean(prefs.data?.vegOnly) });
    return { ok: prefs.status === 200 && set.status === 200 && set.data?.vegOnly === !prefs.data?.vegOnly && bad.status === 422, detail: `${prefs.status}/${set.status}/${bad.status}` };
  });
  await s.run("03-10", "New customer: setting a name completes the profile", "Profile setup: “Complete Profile” → Continue", async () => {
    const nc = await newCustomer(ctx);
    const before2 = await nc.client.call("GET", "/users/me");
    const set = await nc.client.call("PATCH", "/users/me", { name: "Test Newcomer", email: "newcomer@example.com" });
    return { ok: before2.data?.profileComplete === false && set.status === 200 && set.data?.profileComplete === true, detail: `${before2.data?.profileComplete} → ${set.data?.profileComplete}` };
  });
  return s;
}
