import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/common/errors/AppError.js";
import { errorHandler } from "../src/common/middleware/errorHandler.js";
import { env } from "../src/config/env.js";
import { acquireLock, renewLock } from "../src/infrastructure/redisStore.js";
import { handshakeToken, offeredProtocols, selectProtocol } from "../src/realtime/handshake.js";
import { deliveryRoute } from "../src/realtime/hub.js";

const jwt = "aaa.bbb.ccc";

test("socket token: subprotocol first, ?token= for older apps", () => {
  const url = (query = "") => new URL(`/ws${query}`, "http://localhost");
  assert.equal(handshakeToken({ "sec-websocket-protocol": jwt }, url()), jwt);
  assert.equal(handshakeToken({ "sec-websocket-protocol": `mealji.v1, ${jwt}` }, url("?token=old.old.old")), jwt);
  assert.equal(handshakeToken({}, url("?token=old.old.old")), "old.old.old");
  assert.equal(handshakeToken({ "sec-websocket-protocol": "mealji.v1" }, url()), null);
  assert.deepEqual(offeredProtocols(" a , b ,"), ["a", "b"]);
});

test("socket subprotocol answer: a named protocol when offered, else the token", () => {
  assert.equal(selectProtocol(new Set([jwt])), jwt);
  assert.equal(selectProtocol(new Set([jwt, "mealji.v1"])), "mealji.v1");
  assert.equal(selectProtocol(new Set()), false);
});

test("realtime route is decided per message", () => {
  // Redis not ready (yet): in-process, so single-process development still works.
  assert.deepEqual(deliveryRoute({ publisherReady: false, hasSubscriber: true, subscribed: false }), { redis: false, local: true });
  // Worker (no sockets): through Redis only once it is ready.
  assert.deepEqual(deliveryRoute({ publisherReady: true, hasSubscriber: false, subscribed: false }), { redis: true, local: false });
  // API with a live subscription hears its own message back through Redis.
  assert.deepEqual(deliveryRoute({ publisherReady: true, hasSubscriber: true, subscribed: true }), { redis: true, local: false });
  // API whose subscription is reconnecting: its own sockets get it directly.
  assert.deepEqual(deliveryRoute({ publisherReady: true, hasSubscriber: true, subscribed: false }), { redis: true, local: true });
});

test("lock renewal only extends a lock this process still owns", async () => {
  const key = `test:renew:${Date.now()}`;
  const token = await acquireLock(key, 30);
  assert.ok(token);
  assert.equal(await renewLock(key, token, 30), true);
  assert.equal(await renewLock(key, "someone-else", 30), false);
  assert.equal(await renewLock(`${key}:gone`, token, 30), false);
  assert.equal(await renewLock(key, null, 30), false);
});

function respond(err) {
  const res = {
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  errorHandler(err, {}, res, () => {});
  return res;
}

test("production shows a 5xx message only when the error is marked expose", () => {
  const isProd = env.isProd;
  env.isProd = true;
  try {
    assert.equal(respond(new AppError(502, "Storage upload failed (403) for avatars/x.png")).body.message, "Internal server error");
    assert.equal(respond(new AppError(503, "Google Maps is not configured")).body.message, "Internal server error");
    assert.equal(respond(new AppError(502, "Couldn't connect the call. Please try again.", null, { expose: true })).body.message, "Couldn't connect the call. Please try again.");
    assert.equal(respond(new AppError(409, "Order not found")).body.message, "Order not found");
    assert.equal(respond(new Error("boom")).body.message, "Internal server error");
  } finally {
    env.isProd = isProd;
  }
  assert.equal(respond(new AppError(502, "Storage upload failed")).body.message, "Storage upload failed");
});
