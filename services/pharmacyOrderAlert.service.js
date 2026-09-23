const User = require('../models/User');
const PharmacyStore = require('../models/PharmacyStore');
const Notification = require('../models/Notification');
const { createNotification } = require('./notification.service');

/**
 * Everyone who should be told about activity on one pharmacy store.
 *
 * Membership is `pharmacyStoreIds`, which `provisionPharmacyTenant` maintains.
 * The owner of a freshly provisioned organisation can predate that field being
 * populated, so `defaultPharmacyStoreId` is accepted as a fallback — otherwise
 * a single-branch pharmacy would silently receive nothing.
 */
async function storeStaff(storeId, organizationId) {
  const users = await User.find({
    role: 'pharmacy',
    isActive: { $ne: false },
    $or: [
      { pharmacyStoreIds: storeId },
      { defaultPharmacyStoreId: storeId },
      ...(organizationId ? [{ organizationId, pharmacyStoreIds: { $size: 0 } }] : []),
    ],
  }).select('_id').lean();
  return users.map((u) => u._id);
}

const rupees = (value) => `₹${Math.round(Number(value || 0)).toLocaleString('en-IN')}`;

/**
 * Tells the store a new order has landed.
 *
 * `relatedEntity`/`relatedEntityId` are what the professional app reads to
 * open the order directly instead of dropping the pharmacist in the
 * notification list — the whole point of the alert is to get them to the
 * order they have to accept.
 *
 * Never throws: an order must not fail to be created because a push failed.
 */
async function notifyNewPharmacyOrder(order) {
  try {
    const recipients = await storeStaff(order.storeId, order.organizationId);
    if (recipients.length === 0) return;

    const store = await PharmacyStore.findById(order.storeId).select('name').lean();
    const itemCount = Array.isArray(order.items) ? order.items.length : 0;
    const needsRx = order.prescriptionRequired && order.prescriptionStatus === 'pending_review';

    await Promise.all(
      recipients.map((userId) =>
        createNotification({
          userId,
          title: needsRx ? 'New order — prescription to review' : 'New order received',
          message: `${order.orderNumber} · ${itemCount} ${itemCount === 1 ? 'item' : 'items'} · ${rupees(order.totalAmount)}${store?.name ? ` at ${store.name}` : ''}`,
          type: 'order',
          priority: 'high',
          channels: ['in_app', 'push'],
          relatedEntity: 'pharmacy_order',
          relatedEntityId: order._id,
          data: {
            entityType: 'pharmacy_order',
            orderId: String(order._id),
            orderNumber: order.orderNumber,
            storeId: String(order.storeId),
            requiresPrescriptionReview: needsRx ? 'true' : 'false',
          },
          actionUrl: '/pharmacy/orders',
        }).catch((error) => console.error('New-order alert failed:', error.message)),
      ),
    );
  } catch (error) {
    console.error('New-order alert failed:', error.message);
  }
}

/**
 * The once-a-day greeting, sent the first time the app is opened that day.
 *
 * The "once a day" guarantee lives here, not in the client: an app can be
 * force-stopped and reopened repeatedly, and several devices can be signed
 * into the same account. Both would produce a burst of greetings if the
 * client decided. Checking for today's notification server-side makes the
 * endpoint safe to call on every launch.
 */
async function sendDailyWelcome(user) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const alreadySent = await Notification.exists({
    userId: user._id,
    type: 'system',
    'data.kind': 'daily_welcome',
    createdAt: { $gte: startOfDay },
  });
  if (alreadySent) return { sent: false, reason: 'already_sent_today' };

  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = String(user.name || '').trim().split(' ')[0] || 'there';

  const stores = await PharmacyStore.find({
    _id: { $in: user.pharmacyStoreIds?.length ? user.pharmacyStoreIds : [user.defaultPharmacyStoreId] },
  }).select('_id ecommerce').lean();
  const paused = stores.some((s) => s.ecommerce?.pausedUntil && new Date(s.ecommerce.pausedUntil) > new Date());
  const offline = stores.length > 0 && stores.every((s) => s.ecommerce?.enabled === false);

  // The greeting is also the day's first status check — being told at 9am
  // that the store is still switched off is the useful half of it.
  const message = offline
    ? 'Your store is not accepting online orders. Turn it on to start receiving them.'
    : paused
      ? 'Your store is paused. Resume it when you are ready for orders.'
      : 'Your store is open and ready for orders today.';

  await createNotification({
    userId: user._id,
    title: `${part}, ${firstName}`,
    message,
    type: 'system',
    channels: ['in_app', 'push'],
    data: { kind: 'daily_welcome' },
    actionUrl: '/pharmacy/home',
  });

  return { sent: true };
}

module.exports = { notifyNewPharmacyOrder, storeStaff, sendDailyWelcome };
