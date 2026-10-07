// Loyalty reactions to other modules' events.
export function registerHandlers(subscribe) {
  // Referral pays out on the referee's first delivered order.
  subscribe("order.delivered", "loyalty.referral_conversion", async (event) => {
    const { Order } = await import("../order/order.model.js");
    const delivered = await Order.countDocuments({ user: event.payload.userId, status: "delivered" });
    if (delivered !== 1) return;
    const { convertReferral } = await import("./rewards.service.js");
    await convertReferral(event.payload.userId, event.payload.orderId);
  });
  // Mark reward coupons used when an order with them is paid/placed.
  subscribe("order.placed", "loyalty.reward_coupon_used", async (event) => {
    const { Order } = await import("../order/order.model.js");
    const order = await Order.findById(event.payload.orderId).select("couponCode").lean();
    if (!order?.couponCode?.startsWith("RW")) return;
    const { RewardRedemption } = await import("./rewards.model.js");
    await RewardRedemption.updateOne({ couponCode: order.couponCode, status: "issued" }, { $set: { status: "used" } });
  });
}
