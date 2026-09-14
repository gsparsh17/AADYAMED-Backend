const mongoose = require('mongoose');

const paymentWebhookEventSchema = new mongoose.Schema({
  eventKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  eventType: {
    type: String,
    required: true,
    index: true,
  },
  gateway: {
    type: String,
    enum: ['razorpay'],
    default: 'razorpay',
  },
  status: {
    type: String,
    enum: ['processing', 'processed', 'ignored', 'failed'],
    default: 'processing',
  },
  gatewayOrderId: String,
  gatewayPaymentId: String,
  payloadHash: String,
  error: String,
  processedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('PaymentWebhookEvent', paymentWebhookEventSchema);
