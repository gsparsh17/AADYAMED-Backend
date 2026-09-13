const mongoose = require('mongoose');

const pharmacyStoreSchema = new mongoose.Schema({
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  pharmacyProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PharmacyProfile'
  },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  licenseNumber: { type: String, trim: true },
  gstin: { type: String, trim: true, uppercase: true },
  drugLicenseNumber: { type: String, trim: true },
  email: { type: String, lowercase: true, trim: true },
  phone: String,
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: 'India' },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  isDefault: { type: Boolean, default: false },
  operatingHours: mongoose.Schema.Types.Mixed,
  settings: {
    allowNegativeStock: { type: Boolean, default: false },
    expiryAlertDays: { type: Number, default: 30 },
    lowStockThreshold: { type: Number, default: 10 }
  },
  ecommerce: {
    enabled: { type: Boolean, default: true },
    serviceablePincodes: [{ type: String, trim: true }],
    minOrderAmount: { type: Number, default: 0, min: 0 },
    deliveryFee: { type: Number, default: 0, min: 0 },
    freeDeliveryThreshold: { type: Number, default: 0, min: 0 },
    codEnabled: { type: Boolean, default: true },
    onlinePaymentEnabled: { type: Boolean, default: true },
    estimatedDeliveryMinutes: { type: Number, default: 120, min: 15 },
    allowReturns: { type: Boolean, default: true }
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

pharmacyStoreSchema.index({ organizationId: 1, code: 1 }, { unique: true });
pharmacyStoreSchema.index({ organizationId: 1, status: 1 });
pharmacyStoreSchema.index({ pharmacyProfileId: 1 });
pharmacyStoreSchema.index({ 'address.location': '2dsphere' });

module.exports = mongoose.model('PharmacyStore', pharmacyStoreSchema);
