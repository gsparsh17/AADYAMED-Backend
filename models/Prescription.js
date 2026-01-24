const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema({
  medicineName: String,
  genericName: String,
  dosage: String,
  frequency: String,
  duration: String,
  instructions: String,
  quantity: Number,
  unit: String,
  notes: String
});

const testSchema = new mongoose.Schema({
  testName: String,
  testCode: String,
  instructions: String,
  fastingRequired: Boolean,
  notes: String
});

const adviceSchema = new mongoose.Schema({
  category: String,
  advice: String,
  priority: { type: String, enum: ['low', 'medium', 'high'] }
});

const prescriptionSchema = new mongoose.Schema({
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    required: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile',
    required: true
  },
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DoctorProfile'
  },
  physioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysiotherapistProfile'
  },
  professionalType: {
    type: String,
    enum: ['doctor', 'physiotherapist'],
    required: true
  },
  
  // Diagnosis
  diagnosis: [String],
  symptoms: [String],
  notes: String,
  
  // Medications
  medicines: [medicineSchema],
  
  // Tests
  labTests: [testSchema],
  testInstructions: String,
  
  // Advice
  advice: [adviceSchema],
  followUpDate: Date,
  followUpInstructions: String,
  
  // Exercise Prescription (for physio)
  exercises: [{
    name: String,
    description: String,
    sets: Number,
    reps: Number,
    frequency: String,
    duration: String,
    instructions: String
  }],
  
  // Digital Signature
  digitalSignature: String,
  issuedAt: {
    type: Date,
    default: Date.now
  },
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'issued', 'dispensed', 'cancelled'],
    default: 'draft'
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
  
  // Pharmacy
  pharmacyNotes: String,
  dispensedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  dispensedAt: Date,
  
  // Validity
  validityDays: {
    type: Number,
    default: 30
  },
  expiresAt: Date,
  
  // Digital Copy
  prescriptionPdf: String,
  qrCode: String,
  
  // Metadata
  prescriptionNumber: {
    type: String,
    unique: true
  },
  version: {
    type: Number,
    default: 1
  },
  previousVersion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  }
}, {
  timestamps: true
});

prescriptionSchema.index({ patientId: 1, issuedAt: -1 });
prescriptionSchema.index({ appointmentId: 1 });
prescriptionSchema.index({ prescriptionNumber: 1 });
prescriptionSchema.index({ expiresAt: 1 });

// Generate prescription number
prescriptionSchema.pre('save', async function(next) {
  if (!this.prescriptionNumber) {
    const count = await mongoose.model('Prescription').countDocuments();
    this.prescriptionNumber = `RX${Date.now().toString().slice(-8)}${(count + 1).toString().padStart(4, '0')}`;
  }
  if (!this.expiresAt && this.validityDays) {
    this.expiresAt = new Date(this.issuedAt.getTime() + this.validityDays * 24 * 60 * 60 * 1000);
  }
  next();
});

module.exports = mongoose.model('Prescription', prescriptionSchema);