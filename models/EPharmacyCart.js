const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  quantity: { type: Number, required: true, min: 1, max: 99 }
}, { _id: false });

const cartSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, unique: true, index: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', index: true },
  items: [cartItemSchema],
  prescriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  prescriptionUploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'EPharmacyPrescriptionUpload' }
}, { timestamps: true });

module.exports = mongoose.model('EPharmacyCart', cartSchema);
