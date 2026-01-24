const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  referralId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Referral'
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
  
  // Appointment Details
  appointmentDate: {
    type: Date,
    required: true
  },
  startTime: String,
  endTime: String,
  duration: Number, // in minutes
  type: {
    type: String,
    enum: ['clinic', 'home'],
    required: true
  },
  
  // Location
  address: {
    type: String,
    required: function() { return this.type === 'home'; }
  },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] }
  },
  
  // Symptoms & Reason
  symptoms: [String],
  reason: String,
  notes: String,
  
  // Status
  status: {
    type: String,
    enum: [
      'pending',           // Created but not confirmed
      'confirmed',         // Professional confirmed
      'accepted',         // Professional accepted
      'rejected',         // Professional rejected
      'rescheduled',      // Appointment rescheduled
      'cancelled',        // Cancelled by patient/doctor
      'completed',        // Consultation completed
      'no_show',          // Patient didn't show up
      'in_progress'       // Consultation in progress
    ],
    default: 'pending'
  },
  
  // Payment
  consultationFee: {
    type: Number,
    required: true
  },
  homeVisitCharges: {
    type: Number,
    default: 0
  },
  platformCommission: {
    type: Number,
    required: true
  },
  professionalEarning: {
    type: Number,
    required: true
  },
  totalAmount: {
    type: Number,
    required: true
  },
  
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded', 'partially_refunded'],
    default: 'pending'
  },
  paymentId: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentDate: Date,
  
  // Rescheduling/Cancellation
  cancellationReason: String,
  cancelledBy: {
    type: String,
    enum: ['patient', 'professional', 'admin', 'system']
  },
  cancellationFee: {
    type: Number,
    default: 0
  },
  rescheduleCount: {
    type: Number,
    default: 0
  },
  previousAppointments: [{
    appointmentId: mongoose.Schema.Types.ObjectId,
    date: Date,
    reason: String
  }],
  
  // Follow-up
  followUpDate: Date,
  followUpNotes: String,
  isFollowUp: {
    type: Boolean,
    default: false
  },
  originalAppointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  
  // Consultation
  actualStartTime: Date,
  actualEndTime: Date,
  consultationNotes: String,
  prescriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  
  // Notifications
  remindersSent: [{
    type: String,
    enum: ['24h_before', '2h_before', '15min_before'],
    sentAt: Date
  }],
  
  // Metadata
  bookedBy: {
    type: String,
    enum: ['patient', 'admin', 'assistant'],
    default: 'patient'
  },
  deviceInfo: String,
  ipAddress: String
}, {
  timestamps: true
});

appointmentSchema.index({ patientId: 1, status: 1 });
appointmentSchema.index({ professionalId: 1, status: 1 });
appointmentSchema.index({ appointmentDate: 1, startTime: 1 });
appointmentSchema.index({ status: 1, paymentStatus: 1 });
appointmentSchema.index({ 'location': '2dsphere' });

// Calculate professional earning before save
appointmentSchema.pre('save', function(next) {
  if (this.isModified('consultationFee') || this.isModified('platformCommission')) {
    this.professionalEarning = this.consultationFee - this.platformCommission;
    this.totalAmount = this.consultationFee + (this.homeVisitCharges || 0);
  }
  next();
});

module.exports = mongoose.model('Appointment', appointmentSchema);