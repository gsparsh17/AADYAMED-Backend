const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userRole: {
    type: String,
    enum: ['admin', 'doctor', 'physio', 'patient', 'pathology'],
    required: true
  },
  
  // Content
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  data: mongoose.Schema.Types.Mixed, // Additional data for deep linking
  
  // Type
  type: {
    type: String,
    enum: [
      'appointment',
      'payment',
      'prescription',
      'lab_report',
      'verification',
      'commission',
      'system',
      'marketing',
      'reminder'
    ],
    required: true
  },
  
  // Status
  status: {
    type: String,
    enum: ['sent', 'delivered', 'read', 'failed'],
    default: 'sent'
  },
  
  // Channels
  channels: [{
    type: String,
    enum: ['push', 'email', 'sms', 'in_app'],
    required: true
  }],
  
  // Delivery Info
  pushSent: { type: Boolean, default: false },
  pushDelivered: { type: Boolean, default: false },
  emailSent: { type: Boolean, default: false },
  smsSent: { type: Boolean, default: false },
  
  // Read Status
  read: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  
  // Expiry
  expiresAt: Date,
  
  // Action
  actionUrl: String,
  actionText: String,
  
  // Priority
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  
  // Metadata
  relatedEntity: String,
  relatedEntityId: mongoose.Schema.Types.ObjectId,
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ type: 1, status: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Notification', notificationSchema);