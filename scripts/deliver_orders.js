import mongoose from 'mongoose';

async function deliverOrders() {
  await mongoose.connect('mongodb://127.0.0.1:27017/mealji');
  const db = mongoose.connection.db;
  const Order = db.collection('orders');

  const now = new Date();
  const placedAt = new Date(now.getTime() - 35 * 60000);
  const acceptedAt = new Date(now.getTime() - 30 * 60000);
  const readyAt = new Date(now.getTime() - 18 * 60000);
  const dispatchedAt = new Date(now.getTime() - 12 * 60000);
  const deliveredAt = new Date(now.getTime() - 2 * 60000);

  const rider = {
    name: 'Rahul Verma',
    photoUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb',
    phone: '9876543210',
    rating: 4.9,
    vehicleNumber: 'KA 01 EK 4920',
    deliveriesCount: 1240,
  };

  const statusHistory = [
    { status: 'placed', at: placedAt, by: { role: 'customer' }, note: 'Order placed' },
    { status: 'accepted', at: acceptedAt, by: { role: 'kitchen' }, note: 'Accepted by kitchen' },
    { status: 'preparing', at: new Date(now.getTime() - 28 * 60000), by: { role: 'kitchen' }, note: 'Cooking in kadai' },
    { status: 'ready', at: readyAt, by: { role: 'kitchen' }, note: 'Food packed' },
    { status: 'dispatched', at: dispatchedAt, by: { role: 'kitchen' }, note: 'Rider picked up order' },
    { status: 'delivered', at: deliveredAt, by: { role: 'kitchen' }, note: 'Delivered to customer' },
  ];

  const updateFields = {
    status: 'delivered',
    paymentStatus: 'paid',
    placedAt,
    acceptedAt,
    readyAt,
    dispatchedAt,
    deliveredAt,
    rider,
    statusHistory,
  };

  // 1. Update MJ-10084
  const res1 = await Order.updateOne(
    { _id: new mongoose.Types.ObjectId('6ad33cb0d780ac41ec0558ed') },
    { $set: updateFields }
  );
  console.log('MJ-10084 update result:', res1.modifiedCount);

  // 2. Update MJ-10080
  const res2 = await Order.updateOne(
    { _id: new mongoose.Types.ObjectId('6ad3131cf3eef9e682b6b3a8') },
    { $set: updateFields }
  );
  console.log('MJ-10080 update result:', res2.modifiedCount);

  // Check their status now
  const orders = await Order.find({
    _id: {
      $in: [
        new mongoose.Types.ObjectId('6ad33cb0d780ac41ec0558ed'),
        new mongoose.Types.ObjectId('6ad3131cf3eef9e682b6b3a8'),
      ],
    },
  }).toArray();

  orders.forEach((o) => {
    console.log('UPDATED ORDER:', o.orderNumber, o._id, 'Status:', o.status, 'DeliveredAt:', o.deliveredAt);
  });

  await mongoose.disconnect();
}

deliverOrders().catch(console.error);
