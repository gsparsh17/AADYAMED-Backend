const Notification = require('../models/Notification');
const User = require('../models/User');
const sendEmail = require('../utils/sendEmail');
const { sendPushToUser } = require('./pushNotification.service');

async function createNotification(input) {
  const user = await User.findById(input.userId).select('role email preferences').lean();
  if (!user) throw new Error('Notification recipient user not found');

  const requestedChannels = Array.isArray(input.channels) && input.channels.length
    ? input.channels
    : ['in_app'];
  const channels = [...new Set(requestedChannels)];

  const notification = await Notification.create({
    ...input,
    userRole: input.userRole || user.role,
    channels,
  });

  const deliveryErrors = [];

  if (channels.includes('push') && user.preferences?.notifications?.push !== false) {
    try {
      const pushResult = await sendPushToUser(user._id, {
        title: notification.title,
        body: notification.message,
        priority: notification.priority,
        // Not stored on the notification: delivery hints for the push only.
        androidChannel: input.androidChannel,
        ttlSeconds: input.ttlSeconds,
        data: {
          notificationId: notification._id,
          type: notification.type,
          actionUrl: notification.actionUrl || '',
          relatedEntity: notification.relatedEntity || '',
          relatedEntityId: notification.relatedEntityId || '',
          ...(notification.data || {}),
        },
      });
      notification.pushSent = Boolean(pushResult.successCount);
      // FCM success means the provider accepted the message, not that the device displayed it.
      notification.pushDelivered = false;
      notification.metadata = { ...(notification.metadata || {}), pushResult };
    } catch (error) {
      deliveryErrors.push(`push: ${error.message}`);
    }
  }

  if (channels.includes('email') && user.email && user.preferences?.notifications?.email !== false) {
    try {
      await sendEmail({
        to: user.email,
        subject: notification.title,
        html: `<p>${String(notification.message).replace(/[<>]/g, '')}</p>`,
      });
      notification.emailSent = true;
    } catch (error) {
      deliveryErrors.push(`email: ${error.message}`);
    }
  }

  if (deliveryErrors.length) {
    notification.metadata = { ...(notification.metadata || {}), deliveryErrors };
  }

  if (notification.isModified()) await notification.save();
  return notification;
}

module.exports = { createNotification };
