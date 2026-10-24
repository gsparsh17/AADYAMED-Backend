const mongoose = require('mongoose');

/**
 * The Schedule H1 / X register a pharmacy must keep under the Drugs and
 * Cosmetics Rules: who received the drug, who prescribed it, how much and from
 * which batch. One entry per scheduled line dispensed. Entries are written by
 * the server when an online order is accepted, so the register can't be
 * forgotten on a busy day; they are never edited, only read.
 *
 * Schedule H lines are recorded too — not legally required, but stores asked
 * to see every prescription-only sale in one place.
 */
const scheduledDrugRegisterSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', index: true },
  schedule: { type: String, enum: ['Schedule H', 'Schedule H1', 'Schedule X'], required: true, index: true },
  source: { type: String, enum: ['online_order', 'counter_sale'], default: 'online_order' },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'EPharmacyOrder', index: true },
  orderNumber: String,
  saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacySale' },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine' },
  medicineName: String,
  genericName: String,
  strength: String,
  quantity: Number,
  batches: [{
    _id: false,
    batchNumber: String,
    expiryDate: Date,
    quantity: Number
  }],
  patientName: String,
  patientPhone: String,
  patientAddress: String,
  prescriberName: String,
  prescriberRegistration: String,
  prescriptionDate: Date,
  prescriptionRef: String,
  dispensedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispensedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

scheduledDrugRegisterSchema.index({ storeId: 1, dispensedAt: -1 });

module.exports = mongoose.model('ScheduledDrugRegister', scheduledDrugRegisterSchema);
