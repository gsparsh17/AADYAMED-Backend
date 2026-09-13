const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', index: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  description: String,
  discountType: { type: String, enum: ['percent', 'fixed'], required: true },
  value: { type: Number, required: true, min: 0 },
  minOrderAmount: { type: Number, default: 0, min: 0 },
  maxDiscount: { type: Number, min: 0 },
  startsAt: Date,
  endsAt: Date,
  usageLimit: { type: Number, min: 1 },
  perUserLimit: { type: Number, default: 1, min: 1 },
  usageCount: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  redemptions: [{
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'EPharmacyOrder' },
    redeemedAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

schema.index({ storeId: 1, code: 1 }, { unique: true });
schema.index({ organizationId: 1, isActive: 1 });
module.exports = mongoose.model('EPharmacyCoupon', schema);
