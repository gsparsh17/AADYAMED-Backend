const mongoose = require('mongoose');

const paymentAttemptSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  entityType: {
    type: String,
    enum: ['appointment', 'labtest', 'pharmacy_order'],
    required: true,
    index: true,
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  amountPaise: {
    type: Number,
    required: true,
    min: 1,
  },
  currency: {
    type: String,
    default: 'INR',
    uppercase: true,
  },
  idempotencyKey: {
    type: String,
    trim: true,
  },
  gateway: {
    type: String,
    enum: ['razorpay'],
    default: 'razorpay',
  },
  gatewayOrderId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  gatewayPaymentId: {
    type: String,
    sparse: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['created', 'authorized', 'captured', 'failed', 'refunded'],
    default: 'created',
    index: true,
  },
  failureCode: String,
  failureDescription: String,
  verifiedAt: Date,
  capturedAt: Date,
  refundedAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

paymentAttemptSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
paymentAttemptSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
paymentAttemptSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentAttempt', paymentAttemptSchema);
