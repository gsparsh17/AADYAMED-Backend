const mongoose = require('mongoose');
const crypto = require('crypto');

const medicineSchema = new mongoose.Schema({
  medicineName: { type: String, trim: true },
  genericName: { type: String, trim: true },
  dosage: { type: String, trim: true },
  frequency: { type: String, trim: true },
  duration: { type: String, trim: true },
  instructions: { type: String, trim: true },
  quantity: { type: Number, min: 0 },
  prescribedQuantity: { type: Number, min: 0 },
  unit: { type: String, trim: true },
  notes: { type: String, trim: true }
}, { _id: true });

const testSchema = new mongoose.Schema({
  testName: { type: String, trim: true },
  testCode: { type: String, trim: true },
  instructions: { type: String, trim: true },
  fastingRequired: Boolean,
  notes: { type: String, trim: true }
}, { _id: true });

const adviceSchema = new mongoose.Schema({
  category: { type: String, trim: true },
  advice: { type: String, trim: true },
  priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' }
}, { _id: true });

const exerciseSchema = new mongoose.Schema({
  name: String,
  description: String,
  sets: Number,
  reps: Number,
  frequency: String,
  duration: String,
  instructions: String
}, { _id: true });

const prescriptionSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile', index: true },
  physioId: { type: mongoose.Schema.Types.ObjectId, ref: 'PhysiotherapistProfile', index: true },
  professionalType: { type: String, enum: ['doctor', 'physio'], required: true },

  diagnosis: [{ type: String, trim: true }],
  symptoms: [{ type: String, trim: true }],
  notes: { type: String, trim: true },
  medicines: [medicineSchema],
  labTests: [testSchema],
  testInstructions: { type: String, trim: true },
  advice: [adviceSchema],
  patientInstructions: { type: String, trim: true },
  followUpDate: Date,
  followUpInstructions: { type: String, trim: true },
  exercises: [exerciseSchema],

  digitalSignature: String,
  issuedAt: Date,
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  status: {
    type: String,
    enum: ['draft', 'issued', 'superseded', 'cancelled'],
    default: 'draft',
    index: true
  },

  pharmacyStatus: {
    type: String,
    enum: ['not_dispensed', 'partially_dispensed', 'fully_dispensed', 'cancelled'],
    default: 'not_dispensed'
  },
  dispensedItems: [{
    medicineId: mongoose.Schema.Types.ObjectId,
    batchId: mongoose.Schema.Types.ObjectId,
    quantity: Number,
    unit: String,
    dispensedAt: Date,
    dispensedBy: mongoose.Schema.Types.ObjectId,
    pharmacySaleId: mongoose.Schema.Types.ObjectId
  }],
  pharmacyNotes: String,
  dispensedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispensedAt: Date,

  validityDays: { type: Number, default: 30, min: 1, max: 365 },
  expiresAt: Date,
  prescriptionPdf: String,
  qrCode: String,

  prescriptionNumber: { type: String, unique: true, index: true },
  version: { type: Number, default: 1, min: 1 },
  previousVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  cancelledAt: Date,
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cancellationReason: String
}, { timestamps: true });

prescriptionSchema.index({ patientId: 1, issuedAt: -1 });
prescriptionSchema.index({ doctorId: 1, issuedAt: -1 });
prescriptionSchema.index({ physioId: 1, issuedAt: -1 });
prescriptionSchema.index({ appointmentId: 1, version: -1 });
prescriptionSchema.index({ expiresAt: 1 });

prescriptionSchema.pre('validate', function(next) {
  if (!this.prescriptionNumber) {
    const day = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    this.prescriptionNumber = `RX${day}${suffix}`;
  }

  if (this.status === 'issued') {
    this.issuedAt = this.issuedAt || new Date();
    if (!this.expiresAt) {
      this.expiresAt = new Date(this.issuedAt.getTime() + Number(this.validityDays || 30) * 24 * 60 * 60 * 1000);
    }
  }
  next();
});

module.exports = mongoose.model('Prescription', prescriptionSchema);
