const Notification = require('../models/Notification');
const User = require('../models/User');
const DeviceRegistration = require('../models/DeviceRegistration');
const { createNotification } = require('../services/notification.service');
const { sendDailyWelcome } = require('../services/pharmacyOrderAlert.service');

exports.getNotifications = async (req, res) => {
  try {
    const { read, type, page = 1, limit = 20 } = req.query;
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    const filter = { userId: req.user.id };
    if (read !== undefined) filter.read = read === 'true';
    if (type) filter.type = type;

    const [notifications, unreadCount, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize),
      Notification.countDocuments({ userId: req.user.id, read: false }),
      Notification.countDocuments(filter),
    ]);

    res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        pages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { read: true, readAt: new Date(), status: 'read' } },
      { new: true },
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, notification });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.id, read: false },
      { $set: { read: true, readAt: new Date(), status: 'read' } },
    );

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user.id,
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Called by the app on every launch. Sends the day's greeting the first time
 * it is called that day and does nothing on every later call, so the client
 * needs no "have I already done this today" state of its own.
 */
exports.dailyWelcome = async (req, res) => {
  try {
    const result = await sendDailyWelcome(req.user);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.registerDeviceToken = async (req, res) => {
  try {
    const { token, platform = 'unknown', app = 'unknown', deviceId } = req.body;
    if (!token || typeof token !== 'string' || token.trim().length < 20) {
      return res.status(400).json({ success: false, message: 'A valid device token is required' });
    }

    const normalizedPlatform = ['android', 'ios', 'web'].includes(platform) ? platform : 'unknown';
    const normalizedApp = ['aadyaplus', 'aadyapluspro', 'web'].includes(app) ? app : 'unknown';

    // A push token belongs to one logged-in account at a time.
    const registration = await DeviceRegistration.findOneAndUpdate(
      { token: token.trim() },
      {
        $set: {
          userId: req.user.id,
          platform: normalizedPlatform,
          app: normalizedApp,
          deviceId: deviceId || undefined,
          active: true,
          lastSeenAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Keep the legacy single token populated during the migration window.
    await User.findByIdAndUpdate(req.user.id, { $set: { deviceToken: token.trim() } });

    res.json({ success: true, registration });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'Device registration conflict. Retry token registration.' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.unregisterDeviceToken = async (req, res) => {
  try {
    const { token, deviceId, app } = req.body;
    if (!token && !deviceId) {
      return res.status(400).json({ success: false, message: 'token or deviceId is required' });
    }

    const filter = { userId: req.user.id };
    if (token) filter.token = token;
    if (deviceId) filter.deviceId = deviceId;
    if (app) filter.app = app;

    await DeviceRegistration.updateMany(filter, {
      $set: { active: false, lastSeenAt: new Date() },
    });

    if (token && req.user.deviceToken === token) {
      await User.findByIdAndUpdate(req.user.id, { $unset: { deviceToken: 1 } });
    }

    res.json({ success: true, message: 'Device token unregistered' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendNotification = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { userIds, title, message, type, data, channels, actionUrl, priority } = req.body;
    if (!Array.isArray(userIds) || !userIds.length || !title || !message || !type) {
      return res.status(400).json({
        success: false,
        message: 'userIds, title, message and type are required',
      });
    }

    const notifications = [];
    for (const userId of [...new Set(userIds.map(String))]) {
      const notification = await createNotification({
        userId,
        title,
        message,
        type,
        data,
        channels: channels || ['in_app', 'push'],
        actionUrl,
        priority: priority || 'high',
      });
      notifications.push(notification);
    }

    res.json({ success: true, notifications });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
