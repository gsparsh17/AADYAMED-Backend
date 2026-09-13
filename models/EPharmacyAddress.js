const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
  label: { type: String, enum: ['Home', 'Work', 'Other'], default: 'Home' },
  contactName: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  line1: { type: String, required: true, trim: true },
  line2: { type: String, trim: true },
  landmark: { type: String, trim: true },
  city: { type: String, required: true, trim: true },
  state: { type: String, required: true, trim: true },
  pincode: { type: String, required: true, trim: true, match: [/^[1-9][0-9]{5}$/, 'Invalid Indian pincode'] },
  country: { type: String, default: 'India' },
  isDefault: { type: Boolean, default: false },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [0, 0] }
  }
}, { timestamps: true });

addressSchema.index({ patientId: 1, isDefault: 1 });
addressSchema.index({ location: '2dsphere' });
module.exports = mongoose.model('EPharmacyAddress', addressSchema);
