const mongoose = require('mongoose');

/**
 * A payment collected at the pharmacy counter through a Razorpay UPI QR.
 *
 * Deliberately not a `PaymentAttempt`: that model is the patient-side flow —
 * it requires the payer's `userId` and a Razorpay *order* id. A walk-in has no
 * account, the cashier is not the payer, and a QR is identified by `qr_id`.
 * Forcing those semantics onto PaymentAttempt would make both models lie.
 */
const counterPaymentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', required: true, index: true },

  // Exactly one of these is set — enforced in the pre-validate hook below.
  saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacySale', index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'EPharmacyOrder', index: true },

  amountPaise: { type: Number, required: true, min: 100 },
  currency: { type: String, default: 'INR', uppercase: true },

  qrId: { type: String, required: true, unique: true, index: true },
  qrImageUrl: String,
  shortUrl: String,
  closeBy: Date,

  status: {
    type: String,
    enum: ['created', 'paid', 'closed', 'expired'],
    default: 'created',
    index: true
  },

  razorpayPaymentId: { type: String, sparse: true, index: true },
  amountPaidPaise: { type: Number, default: 0 },
  paidAt: Date,
  payerVpa: String,

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  closedAt: Date
}, { timestamps: true });

counterPaymentSchema.index({ organizationId: 1, storeId: 1, status: 1, createdAt: -1 });

counterPaymentSchema.pre('validate', function (next) {
  if (!this.saleId && !this.orderId) {
    return next(new Error('A counter payment must reference a sale or an order'));
  }
  if (this.saleId && this.orderId) {
    return next(new Error('A counter payment cannot reference both a sale and an order'));
  }
  next();
});

module.exports = mongoose.model('CounterPayment', counterPaymentSchema);
