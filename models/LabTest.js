const mongoose = require('mongoose');

const testResultSchema = new mongoose.Schema({
  parameter: String,
  value: String,
  unit: String,
  normalRange: String,
  flag: { type: String, enum: ['normal', 'high', 'low', 'critical'] },
  notes: String
});

const sampleSchema = new mongoose.Schema({
  sampleType: String,
  collectionTime: Date,
  collectedBy: String,
  notes: String
});

const labTestSchema = new mongoose.Schema({
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  prescriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
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
  pathologyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PathologyProfile',
    required: true
  },
  
  // Test Details
  tests: [{
    testCode: String,
    testName: String,
    price: Number,
    status: {
      type: String,
      enum: ['pending', 'sample_collected', 'processing', 'completed', 'cancelled'],
      default: 'pending'
    },
    requestedAt: Date,
    completedAt: Date
  }],
  
  // Scheduling
  scheduledDate: Date,
  scheduledTime: String,
  type: {
    type: String,
    enum: ['lab_visit', 'home_collection'],
    required: true
  },
  collectionAddress: {
    type: String,
    required: function() { return this.type === 'home_collection'; }
  },
  
  // Sample
  sample: sampleSchema,
  
  // Results
  results: [testResultSchema],
  resultNotes: String,
  reviewedByDoctor: {
    type: Boolean,
    default: false
  },
  reviewedAt: Date,
  
  // Report
  reportUrl: String,
  reportGeneratedAt: Date,
  reportViewedByPatient: {
    type: Boolean,
    default: false
  },
  reportViewedAt: Date,
  
  // Payment
  totalAmount: Number,
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending'
  },
  paymentId: String,
  
  // Status
  status: {
    type: String,
    enum: [
      'requested',
      'scheduled',
      'sample_collected',
      'processing',
      'ready_for_review',
      'completed',
      'cancelled'
    ],
    default: 'requested'
  },
  
  // Notifications
  notifications: [{
    type: String,
    sentAt: Date,
    recipient: String
  }],
  
  // Metadata
  labTestNumber: {
    type: String,
    unique: true
  },
  instructions: String,
  fastingRequired: Boolean,
  fastingHours: Number,
  specialInstructions: String
}, {
  timestamps: true
});

labTestSchema.index({ patientId: 1, status: 1 });
labTestSchema.index({ pathologyId: 1, scheduledDate: 1 });
labTestSchema.index({ appointmentId: 1 });
labTestSchema.index({ labTestNumber: 1 });

// Generate lab test number
labTestSchema.pre('save', async function(next) {
  if (!this.labTestNumber) {
    const count = await mongoose.model('LabTest').countDocuments();
    this.labTestNumber = `LT${Date.now().toString().slice(-8)}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('LabTest', labTestSchema);