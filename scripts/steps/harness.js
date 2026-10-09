// Shared helpers for the release-step tests (scripts/steps/stepNN.js).
// Each test case is written from what the customer app's screens need and
// states the CORRECT behaviour, so a failing case is a gap to fix.

import mongoose from "mongoose";
import { env } from "../../src/config/env.js";

export const ROOT = String(process.env.SMOKE_API || `http://localhost:${env.port || 4000}`).replace(/\/$/, "");
export const BASE = `${ROOT}/api/v1`;
export const DEMO = { customer: "9000000031", newCustomer: "9000000099", otherCustomer: "9000000032", admin: "9000000001" };
export const POINTS = {
  served: { latitude: 12.942795, longitude: 77.624478 },
  notServed: { latitude: 13.1986, longitude: 77.7066 },
};

export class Client {
  constructor(deviceId) {
    this.headers = { "Content-Type": "application/json" };
    if (deviceId) this.headers["x-device-id"] = deviceId;
  }

  async call(method, path, body, { raw = false, headers = {} } = {}) {
    const res = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
      method,
      headers: { ...this.headers, ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, body: json, data: json?.data, message: json?.message, errors: json?.errors };
  }

  async signIn(phone, { staff = false } = {}) {
    const login = await this.call("POST", staff ? "/auth/staff-login" : "/auth/login", { countryCode: "+91", phoneNumber: phone });
    const verify = await this.call("POST", "/auth/verify-otp", { userId: login.data?.userId, otp: env.fixedOtp });
    this.headers.Authorization = `Bearer ${verify.data?.accessToken}`;
    this.session = verify.data;
    return verify;
  }
}

/** Collects cases for one step: case(id, title, requirement) → check(ok, detail). */
export function createSuite(step, title) {
  const cases = [];
  const cleanups = [];
  return {
    step,
    title,
    cases,
    cleanups,
    async run(id, name, requirement, fn) {
      const entry = { id, name, requirement, ok: false, detail: "" };
      try {
        const result = await fn();
        // A check returning { ok, detail } passes only when ok is truthy (undefined = fail).
        entry.ok = result !== null && typeof result === "object" ? Boolean(result.ok) : Boolean(result);
        entry.detail = result?.detail ?? "";
        if (result?.warning) entry.warning = result.warning;
      } catch (err) {
        entry.ok = false;
        entry.detail = `crashed: ${err.message}`;
      }
      cases.push(entry);
      console.log(`  ${entry.ok ? (entry.warning ? "!" : "✓") : "✗"} ${id} ${name}${entry.detail ? ` — ${String(entry.detail).slice(0, 160)}` : ""}`);
      return entry;
    },
    onCleanup(fn) {
      cleanups.push(fn);
    },
  };
}

export async function db() {
  if (mongoose.connection.readyState !== 1) await mongoose.connect(env.mongoUri);
  return mongoose.connection.db;
}

export const headOk = async (url) => {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
};

/**
 * A signed-in demo "new customer" (9000000099): never signed in before, name
 * not set, flagged isDemo so no real message can reach the number. Created
 * once per run and removed by the runner's cleanup.
 */
export async function newCustomer(ctx, { reset = false } = {}) {
  if (ctx.newCustomer && !reset) return ctx.newCustomer;
  const database = await db();
  const role = await database.collection("roles").findOne({ slug: "user" });
  const old = await database.collection("users").findOne({ countryCode: "+91", phoneNumber: DEMO.newCustomer });
  if (old) await database.collection("addresses").deleteMany({ user: old._id });
  await database.collection("users").deleteOne({ countryCode: "+91", phoneNumber: DEMO.newCustomer });
  await database.collection("users").insertOne({ name: "User", countryCode: "+91", phoneNumber: DEMO.newCustomer, role: role._id, isActive: false, isNumberVerified: false, isDemo: true, lastLoginAt: null, createdAt: new Date(), updatedAt: new Date() });
  if (!ctx.cleanedNewCustomer) {
    ctx.cleanedNewCustomer = true;
    ctx.cleanups.push(async () => {
      const user = await database.collection("users").findOne({ countryCode: "+91", phoneNumber: DEMO.newCustomer });
      if (user) {
        await database.collection("addresses").deleteMany({ user: user._id });
        await database.collection("users").deleteOne({ _id: user._id });
      }
    });
  }
  const client = new Client(`new-customer-${Date.now()}`);
  const login = await client.call("POST", "/auth/login", { countryCode: "+91", phoneNumber: DEMO.newCustomer });
  const verify = await client.call("POST", "/auth/verify-otp", { userId: login.data?.userId, otp: env.fixedOtp });
  client.headers.Authorization = `Bearer ${verify.data?.accessToken}`;
  ctx.newCustomer = { client, login, verify, userId: login.data?.userId };
  return ctx.newCustomer;
}

export { env, mongoose };
