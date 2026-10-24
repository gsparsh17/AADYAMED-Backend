const mongoose = require('mongoose');
const crypto = require('crypto');

const orderItemSchema = new mongoose.Schema({
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  medicineName: String,
  genericName: String,
  quantity: { type: Number, required: true, min: 1 },
  // What the customer asked for, kept when the pharmacy can only supply part
  // of it. `quantity` stays the figure everything downstream bills, allocates
  // and ships, so nothing else has to learn about short supply; a line where
  // orderedQuantity > quantity was short-supplied, and one at quantity 0 was
  // dropped entirely.
  orderedQuantity: { type: Number, min: 0 },
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
  // What the pharmacist verified before approving. The prescriber's
  // registration and the prescription date also go into the Schedule H1/X
  // register when the order is accepted.
  prescriptionCheck: {
    prescriberName: String,
    prescriberRegistration: String,
    prescriptionDate: Date,
    signaturePresent: Boolean,
    patientMatches: Boolean,
    medicinesMatch: Boolean,
    withinValidity: Boolean,
    checkedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    checkedAt: Date
  },
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
  // Set when the pharmacy accepted the order for less than was asked for.
  partiallyFulfilled: { type: Boolean, default: false },
  fulfilmentNote: String,
  cancellationReason: String,
  // Set only when the store declined a new order, as opposed to cancelling one
  // it had already accepted. Kept separate from cancellationReason (free text)
  // so acceptance/rejection rates can be aggregated.
  rejectionReason: {
    type: String,
    // no_response: set by the acceptance-timeout job, never by a pharmacist.
    enum: ['out_of_stock', 'store_closed', 'cannot_fulfil', 'prescription_invalid', 'address_not_serviceable', 'other', 'no_response'],
    index: true
  },
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
