const mongoose = require('mongoose');
const crypto = require('crypto');

const orderItemSchema = new mongoose.Schema({
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  medicineName: String,
  genericName: String,
  quantity: { type: Number, required: true, min: 1 },
  unit: String,
  hsnCode: String,
  prescriptionRequired: Boolean,
  unitPrice: Number,
  listedAmount: Number,
  medicineDiscount: Number,
  taxableAmount: Number,
  taxRate: Number,
  taxAmount: Number,
  totalAmount: Number,
  batchAllocations: [{
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
    quantity: Number,
    purchasePrice: Number
  }]
}, { _id: true });

const historySchema = new mongoose.Schema({
  status: String,
  note: String,
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now }
}, { _id: false });

const schema = new mongoose.Schema({
  orderNumber: { type: String, unique: true, index: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
  items: [orderItemSchema],
  deliveryAddress: {
    addressId: mongoose.Schema.Types.ObjectId,
    label: String,
    contactName: String,
    phone: String,
    line1: String,
    line2: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
    country: String
  },
  deliveryInstructions: String,
  prescriptionRequired: { type: Boolean, default: false },
  prescriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  prescriptionUploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'EPharmacyPrescriptionUpload' },
  prescriptionStatus: {
    type: String,
    enum: ['not_required', 'pending_review', 'approved', 'rejected'],
    default: 'not_required',
    index: true
  },
  prescriptionReviewNotes: String,
  couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'EPharmacyCoupon' },
  couponCode: String,
  subtotal: { type: Number, default: 0 },
  medicineDiscount: { type: Number, default: 0 },
  couponDiscount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  paymentMethod: { type: String, enum: ['online', 'cod'], required: true },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'refund_pending', 'refunded', 'failed'], default: 'pending', index: true },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentId: String,
  paymentDate: Date,
  refundId: String,
  refundAmount: { type: Number, default: 0 },
  refundedAt: Date,
  refundFailure: String,
  orderStatus: {
    type: String,
    enum: ['payment_pending', 'prescription_review', 'placed', 'confirmed', 'packing', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivered', 'cancel_requested', 'cancelled', 'returned'],
    default: 'placed',
    index: true
  },
  statusHistory: [historySchema],
  tracking: {
    carrier: String,
    trackingNumber: String,
    trackingUrl: String,
    estimatedDeliveryAt: Date,
    shippedAt: Date,
    outForDeliveryAt: Date,
    deliveredAt: Date
  },
  fulfillmentSaleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacySale' },
  cancellationReason: String,
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ patientId: 1, createdAt: -1 });
schema.index({ organizationId: 1, storeId: 1, orderStatus: 1, createdAt: -1 });

schema.pre('validate', function(next) {
  if (!this.orderNumber) {
    const date = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    this.orderNumber = `EO${date}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }
  next();
});

module.exports = mongoose.model('EPharmacyOrder', schema);
