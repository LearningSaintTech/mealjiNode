import { WebSocketServer } from "ws";
import { logger } from "../config/logger.js";
import { isAccessDenied } from "../infrastructure/accessTokenDenylist.service.js";
import { verifyAccessToken } from "../infrastructure/token.service.js";
import { userRepository } from "../modules/user/user.repository.js";
import { isSuspended, tokenRevoked } from "../modules/user/user.status.js";
import { onMessage, startHub } from "./hub.js";

/**
 * WebSocket endpoint: wss://host/ws?token=<accessToken>. Envelope {type, data}.
 * On connect a socket joins user:{id}; kitchen users join kitchen:{id}; staff
 * with orders.read join admin:ops. Clients add order rooms with
 * {type:"track:subscribe", data:{orderId}} (ownership is checked).
 */

const rooms = new Map(); // room -> Set<socket>
let clients = 0;

function join(socket, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(socket);
  socket.rooms.add(room);
}

function leave(socket, room) {
  rooms.get(room)?.delete(socket);
  if (rooms.get(room)?.size === 0) rooms.delete(room);
  socket.rooms.delete(room);
}

function send(socket, type, data) {
  if (socket.readyState === 1) socket.send(JSON.stringify({ type, data }));
}

async function authenticate(token) {
  if (!token) return null;
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return null;
  }
  if (await isAccessDenied(payload.jti)) return null;
  const user = await userRepository.findById(payload.userId);
  if (!user || !user.isActive || isSuspended(user) || tokenRevoked(user, payload.iat)) return null;
  return { user, payload };
}

async function canWatchOrder(user, orderId) {
  const { Order } = await import("../modules/order/order.model.js");
  const order = await Order.findById(orderId).select("user kitchen").lean().catch(() => null);
  if (!order) return false;
  if (String(order.user) === String(user._id)) return true;
  if (user.kitchen && String(order.kitchen) === String(user.kitchen._id || user.kitchen)) return true;
  return (user.role?.permissions || []).some((permission) => permission.key === "orders.read");
}

export function connectedClients() {
  return clients;
}

export async function attachRealtime(server) {
  await startHub({ subscribe: true });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const auth = await authenticate(url.searchParams.get("token") || String(request.headers["sec-websocket-protocol"] || "").split(",")[0].trim());
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, auth));
  });

  wss.on("connection", (ws, { user, payload }) => {
    clients += 1;
    ws.rooms = new Set();
    ws.isAlive = true;
    join(ws, `user:${user._id}`);
    if (user.kitchen) join(ws, `kitchen:${user.kitchen._id || user.kitchen}`);
    if ((user.role?.permissions || []).some((permission) => permission.key === "orders.read")) join(ws, "admin:ops");
    send(ws, "connected", { userId: String(user._id), rooms: [...ws.rooms] });

    // Close with 4401 when the access token expires; the app reconnects with a fresh one.
    const expiresIn = payload.exp * 1000 - Date.now();
    const expiry = setTimeout(() => ws.close(4401, "token expired"), Math.max(1000, expiresIn));

    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      const orderId = message?.data?.orderId;
      if (message?.type === "ping") return send(ws, "pong", {});
      if (message?.type === "track:subscribe" && orderId) {
        if (ws.rooms.size > 50) return send(ws, "error", { message: "Too many subscriptions" });
        if (await canWatchOrder(user, orderId)) {
          join(ws, `order:${orderId}`);
          send(ws, "track:subscribed", { orderId });
        } else {
          send(ws, "error", { message: "Order not found", orderId });
        }
      }
      if (message?.type === "track:unsubscribe" && orderId) leave(ws, `order:${orderId}`);
      return undefined;
    });
    ws.on("close", () => {
      clients -= 1;
      clearTimeout(expiry);
      for (const room of [...ws.rooms]) leave(ws, room);
    });
  });

  // Drop dead connections.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  onMessage(({ room, type, data }) => {
    for (const ws of rooms.get(room) || []) send(ws, type, data);
  });

  logger.info("Realtime WebSocket ready on /ws");
  return wss;
}
