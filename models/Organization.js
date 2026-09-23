const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  type: {
    type: String,
    enum: ['healthcare_network', 'hospital', 'clinic', 'pharmacy_group', 'independent_pharmacy', 'diagnostic_group'],
    default: 'independent_pharmacy'
  },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active' },
  contact: {
    email: { type: String, lowercase: true, trim: true },
    phone: String
  },
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: 'India' }
  },
  settings: {
    timezone: { type: String, default: 'Asia/Kolkata' },
    currency: { type: String, default: 'INR' },
    gstEnabled: { type: Boolean, default: true }
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

organizationSchema.index({ ownerUserId: 1, status: 1 });
organizationSchema.index({ name: 'text', code: 'text' });
// Prevents the tenant-provisioning race in pharmacyTenant.service.js: without
// this, two concurrent requests from a freshly-registered pharmacy (very
// plausible — e.g. the dashboard loading inventory + sales + profile at once
// right after signup) can both pass the "does an org exist?" check before
// either creates one, producing two organizations/stores for the same owner
// with their data invisibly split between them. Scoped to independent
// pharmacies specifically, since that's the only type this provisioning path
// creates — other org types may legitimately share an owner elsewhere.
organizationSchema.index(
  { ownerUserId: 1 },
  { unique: true, partialFilterExpression: { type: 'independent_pharmacy' } }
);

module.exports = mongoose.model('Organization', organizationSchema);
