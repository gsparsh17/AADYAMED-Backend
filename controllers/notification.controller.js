const Notification = require('../models/Notification');
const User = require('../models/User');
const sendEmail = require('../utils/sendEmail');

exports.getNotifications = async (req, res) => {
  try {
    const { read, type, page = 1, limit = 20 } = req.query;
    
    const filter = { userId: req.user.id };
    if (read !== undefined) filter.read = read === 'true';
    if (type) filter.type = type;
    
    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const unreadCount = await Notification.countDocuments({ 
      userId: req.user.id, 
      read: false 
    });
    
    const total = await Notification.countDocuments(filter);
    
    res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    
    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: req.user.id },
      { read: true, readAt: new Date() },
      { new: true }
    );
    
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json({ success: true, notification });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user.id, read: false },
      { read: true, readAt: new Date() }
    );
    
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    
    const notification = await Notification.findOneAndDelete({
      _id: id,
      userId: req.user.id
    });
    
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.sendNotification = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { userIds, title, message, type, data, channels } = req.body;
    
    const notifications = [];
    
    for (const userId of userIds) {
      const notification = await Notification.create({
        userId,
        userRole: (await User.findById(userId)).role,
        title,
        message,
        type,
        data,
        channels: channels || ['in_app'],
        priority: 'high'
      });
      
      notifications.push(notification);
      
      // Send via other channels
      if (channels?.includes('email')) {
        await sendEmailNotification(userId, title, message);
      }
      if (channels?.includes('sms')) {
        await sendSMSNotification(userId, message);
      }
    }
    
    res.json({ success: true, notifications });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper functions
async function sendEmailNotification(userId, title, message) {
  const user = await User.findById(userId);
  if (user && user.email) {
    await sendEmail({
      to: user.email,
      subject: title,
      html: `<p>${message}</p>`
    });
  }
}

async function sendSMSNotification(userId, message) {
  // Implement SMS integration (Twilio, etc.)
  console.log(`SMS to ${userId}: ${message}`);
}