// Order state machine (pure). Who may move an order from one state to the next.
// Actors: customer, kitchen, admin, system (jobs, payments, delivery partner).

export const ACTIVE_STATUSES = ["placed", "accepted", "preparing", "ready", "dispatched"];
export const FINAL_STATUSES = ["delivered", "cancelled", "payment_failed"];

const TRANSITIONS = {
  payment_pending: { placed: ["system"], payment_failed: ["system", "customer"], cancelled: ["system", "admin", "customer"] },
  payment_failed: { payment_pending: ["customer", "system"], cancelled: ["system", "admin", "customer"] },
  placed: { accepted: ["kitchen", "admin", "system"], cancelled: ["customer", "kitchen", "admin", "system"] },
  accepted: { preparing: ["kitchen", "admin"], ready: ["kitchen", "admin"], cancelled: ["admin", "system"] },
  preparing: { ready: ["kitchen", "admin"], cancelled: ["admin", "system"] },
  ready: { dispatched: ["kitchen", "admin", "system"], delivered: ["kitchen", "admin", "system"], cancelled: ["admin"] },
  dispatched: { delivered: ["kitchen", "admin", "system"], cancelled: ["admin"] },
  delivered: {},
  cancelled: {},
};

export function canTransition(from, to, actor) {
  return Boolean(TRANSITIONS[from]?.[to]?.includes(actor));
}

export function nextStatuses(from, actor) {
  return Object.entries(TRANSITIONS[from] || {}).filter(([, actors]) => actors.includes(actor)).map(([status]) => status);
}

/**
 * Transition check including the delivery mode: pickup orders skip
 * "dispatched" (ready → delivered means collected); delivery orders must be
 * dispatched before they are delivered.
 */
export function allowedFor(order, to, actor) {
  if (!canTransition(order.status, to, actor)) return false;
  if (order.deliveryMode === "pickup" && to === "dispatched") return false;
  if (order.deliveryMode !== "pickup" && order.status === "ready" && to === "delivered") return false;
  return true;
}

export function kitchenActions(order) {
  return nextStatuses(order.status, "kitchen").filter((status) => allowedFor(order, status, "kitchen"));
}

export const STATUS_LABELS = {
  payment_pending: "Waiting for payment",
  payment_failed: "Payment failed",
  placed: "Order placed",
  accepted: "Accepted by the kitchen",
  preparing: "Being prepared",
  ready: "Ready",
  dispatched: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** Whether a customer may cancel under the order policy. */
export function customerCanCancel(order, policy, now = new Date()) {
  if (["payment_pending", "payment_failed"].includes(order.status)) return true;
  if (order.status !== "placed") return false;
  if (policy.customerCancelPolicy === "never") return false;
  if (policy.customerCancelPolicy === "within_window") {
    const placed = new Date(order.placedAt || order.createdAt).getTime();
    return now.getTime() - placed <= (policy.customerCancelWindowMinutes || 0) * 60_000;
  }
  return true; // before_accept
}
