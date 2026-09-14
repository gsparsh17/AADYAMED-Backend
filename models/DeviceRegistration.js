const mongoose = require('mongoose');

const deviceRegistrationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  platform: {
    type: String,
    enum: ['android', 'ios', 'web', 'unknown'],
    default: 'unknown',
  },
  app: {
    type: String,
    enum: ['aadyaplus', 'aadyapluspro', 'web', 'unknown'],
    default: 'unknown',
  },
  deviceId: {
    type: String,
    trim: true,
  },
  active: {
    type: Boolean,
    default: true,
    index: true,
  },
  lastSeenAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

deviceRegistrationSchema.index({ userId: 1, active: 1, updatedAt: -1 });
deviceRegistrationSchema.index(
  { userId: 1, deviceId: 1, app: 1 },
  { unique: true, partialFilterExpression: { deviceId: { $type: 'string' } } },
);

module.exports = mongoose.model('DeviceRegistration', deviceRegistrationSchema);
