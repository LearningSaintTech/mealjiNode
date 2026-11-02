import assert from "node:assert/strict";
import test from "node:test";
import { checkContent, checkSchedule } from "../src/modules/notification/broadcast.service.js";
import { cleanPhones, mediaUrlProblem, needsProfile, placeholders, render, renderAdHoc, userVariables } from "../src/modules/notification/personalize.js";

const HOSTS = ["cdn.mealji.in", "api.mealji.in"];

test("render: variables, nested paths and fallbacks", () => {
  const data = { user: { firstName: "Priya", city: "" }, order: { orderNumber: "MJ-1" } };
  assert.equal(render("Hi {{user.firstName}}, order {{order.orderNumber}}", data), "Hi Priya, order MJ-1");
  assert.equal(render("Meals in {{user.city | your city}}", data), "Meals in your city");
  assert.equal(render("Hi {{ user.missing |friend }}!", data), "Hi friend!");
  assert.equal(render("Code {{couponCode}}.", data), "Code.");
});

test("placeholders and needsProfile: only extra profile fields cost a read", () => {
  assert.deepEqual([...placeholders({ push: { title: "Hi {{user.firstName}}", body: ["{{order.id}}"] } })].sort(), ["order.id", "user.firstName"]);
  assert.equal(needsProfile({ title: "Hi {{user.firstName}} {{user.name}}" }), false);
  assert.equal(needsProfile({ title: "Hi" }, { body: "{{user.pointsBalance}} points" }), true);
});

test("userVariables: first name fallback and profile fields", () => {
  assert.equal(userVariables({ name: "User" }, false).firstName, "there");
  const vars = userVariables({ name: "Priya Nair", phoneNumber: "9876543210", pointsBalance: 120, referralCode: "PRIYA50" }, { city: "noida", deliveredOrdersCount: 8, isPlusMember: true });
  assert.deepEqual([vars.firstName, vars.phoneLast4, vars.city, vars.pointsBalance, vars.ordersCount, vars.isPlusMember], ["Priya", "3210", "Noida", 120, 8, "yes"]);
});

test("renderAdHoc: free text is personalised, other data is left alone", () => {
  const out = renderAdHoc({ title: "Hi {{user.firstName}}", body: "{{user.city | Noida}} special", note: "{{user.firstName}}" }, { user: { firstName: "Raw" } });
  assert.deepEqual(out, { title: "Hi Raw", body: "Noida special", note: "{{user.firstName}}" });
});

test("mediaUrlProblem: https images on MealJi hosts only", () => {
  assert.equal(mediaUrlProblem("", HOSTS), null);
  assert.equal(mediaUrlProblem("https://cdn.mealji.in/notification/a.jpg", HOSTS), null);
  assert.match(mediaUrlProblem("http://cdn.mealji.in/a.jpg", HOSTS), /https/);
  assert.match(mediaUrlProblem("https://evil.example/a.jpg", HOSTS), /uploaded to MealJi/);
  assert.match(mediaUrlProblem("https://cdn.mealji.in/a.svg", HOSTS), /JPG, PNG/);
  assert.match(mediaUrlProblem("not a url", HOSTS), /valid URL/);
});

test("cleanPhones: pasted CSV, +91 prefixes, duplicates and junk", () => {
  assert.deepEqual(cleanPhones("name,phone\nA,+91 98765 43210\nB,9876543210\nC,12345\nD,09123456789"), ["9876543210", "9123456789"]);
  assert.deepEqual(cleanPhones(["8000000001", "5000000000"]), ["8000000001"]);
});

test("checkContent: lengths, unknown variables, images and links", () => {
  assert.deepEqual(checkContent({ title: " Hi {{user.firstName}} ", body: "Lunch is ready", deepLink: "mealji://menu" }, HOSTS), { title: "Hi {{user.firstName}}", body: "Lunch is ready", imageUrl: "", deepLink: "mealji://menu" });
  const problems = (content) => {
    try {
      checkContent(content, HOSTS);
      return [];
    } catch (err) {
      return err.errors.map((item) => item.field);
    }
  };
  assert.deepEqual(problems({ title: "H", body: "ok body" }), ["content.title"]);
  assert.deepEqual(problems({ title: "Hello", body: "Hi {{user.password}}" }), ["content.body"]);
  assert.deepEqual(problems({ title: "Hello", body: "Body", imageUrl: "https://evil.example/a.png" }), ["content.imageUrl"]);
  assert.deepEqual(problems({ title: "Hello", body: "Body", deepLink: "https://evil.example/" }), ["content.deepLink"]);
  assert.deepEqual(problems({ title: "Hello", body: "Body", deepLink: "https://api.mealji.in/offers" }), []);
});

test("checkSchedule: now, once within 90 days, recurring", () => {
  const now = new Date("2026-11-02T06:00:00Z");
  assert.deepEqual(checkSchedule({}, now), { type: "now" });
  assert.equal(checkSchedule({ sendAt: "2026-11-02T12:30:00Z" }, now).type, "once");
  assert.throws(() => checkSchedule({ type: "once", sendAt: "2026-11-02T05:00:00Z" }, now), /at least a minute/);
  assert.throws(() => checkSchedule({ type: "once", sendAt: "2027-03-01T00:00:00Z" }, now), /90 days/);
  assert.deepEqual(checkSchedule({ type: "recurring", frequency: "weekly", time: "18:00", weekday: 5 }, now), { type: "recurring", frequency: "weekly", time: "18:00", weekday: 5, endAt: null });
  assert.throws(() => checkSchedule({ type: "recurring", frequency: "daily", time: "25:00" }, now), /HH:mm/);
});
