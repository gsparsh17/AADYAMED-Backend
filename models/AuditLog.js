const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  userRole: {
    type: String,
    enum: ['admin', 'doctor', 'physiotherapist', 'patient', 'pathology', 'system']
  },
  action: {
    type: String,
    required: true
  },
  entity: String,
  entityId: mongoose.Schema.Types.ObjectId,
  
  // Changes
  beforeState: mongoose.Schema.Types.Mixed,
  afterState: mongoose.Schema.Types.Mixed,
  changes: [{
    field: String,
    oldValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed
  }],
  
  // Request Info
  endpoint: String,
  method: String,
  statusCode: Number,
  requestBody: mongoose.Schema.Types.Mixed,
  queryParams: mongoose.Schema.Types.Mixed,
  
  // Technical Info
  ipAddress: String,
  userAgent: String,
  deviceInfo: String,
  
  // Location
  location: {
    city: String,
    region: String,
    country: String,
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] }
    }
  },
  
  // Performance
  responseTime: Number, // in milliseconds
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
});

auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ entity: 1, entityId: 1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ 'location.coordinates': '2dsphere' });

// Auto-delete logs older than 90 days
auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLog);