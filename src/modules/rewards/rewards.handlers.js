// Loyalty reactions to other modules' events.
export function registerHandlers(subscribe) {
  // Referral pays out on the referee's first delivered order.
  subscribe("order.delivered", "loyalty.referral_conversion", async (event) => {
    // Pays out on the first delivered order handled while the referral is still pending
    // (a second delivery landing first no longer skips it; convertReferral only acts once).
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
  // The order was cancelled: its reward code can be used again (the coupon use is released too).
  subscribe("order.cancelled", "loyalty.reward_coupon_back", async (event) => {
    const { Order } = await import("../order/order.model.js");
    const order = await Order.findById(event.payload.orderId).select("couponCode").lean();
    if (!order?.couponCode?.startsWith("RW")) return;
    const { RewardRedemption } = await import("./rewards.model.js");
    await RewardRedemption.updateOne({ couponCode: order.couponCode, status: "used", expiresAt: { $gt: new Date() } }, { $set: { status: "issued" } });
  });
}
