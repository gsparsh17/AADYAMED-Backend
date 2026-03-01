const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userRole: { type: String },

    action: { type: String, required: true },
    entity: { type: String },
    entityId: { type: mongoose.Schema.Types.ObjectId },

    endpoint: { type: String },
    method: { type: String },
    statusCode: { type: Number },

    requestBody: { type: mongoose.Schema.Types.Mixed },
    queryParams: { type: mongoose.Schema.Types.Mixed },

    ipAddress: { type: String },
    userAgent: { type: String },

    // ✅ GeoJSON Point (only set when you actually have coords)
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number], // [lng, lat]
        validate: {
          validator: function (arr) {
            // allow missing location
            if (arr === undefined || arr === null) return true;
            return Array.isArray(arr) && arr.length === 2 && arr.every((n) => typeof n === 'number');
          },
          message: 'location.coordinates must be [lng, lat]',
        },
      },
    },

    responseTime: { type: Number },
    changes: { type: [mongoose.Schema.Types.Mixed], default: [] },

    timestamp: { type: Date, default: Date.now },
  },
  { minimize: true }
);

// ✅ Index only when coordinates exist (prevents invalid geo index inserts)
AuditLogSchema.index(
  { location: '2dsphere' },
  {
    partialFilterExpression: {
      'location.type': { $eq: 'Point' },
      'location.coordinates.0': { $exists: true },
      'location.coordinates.1': { $exists: true },
    },
  }
);

module.exports = mongoose.model('AuditLog', AuditLogSchema);