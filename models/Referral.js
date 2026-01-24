const mongoose = require('mongoose');

const symptomSchema = new mongoose.Schema({
  symptom: String,
  duration: String, // e.g., "3 days", "1 week"
  severity: { type: String, enum: ['mild', 'moderate', 'severe'] }
});

const doctorSuggestionSchema = new mongoose.Schema({
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DoctorProfile'
  },
  physioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysiotherapistProfile'
  },
  type: {
    type: String,
    enum: ['doctor', 'physiotherapist'],
    required: true
  },
  matchScore: Number,
  reason: String,
  consultationFee: Number,
  homeVisitFee: Number,
  averageRating: Number,
  distance: Number, // in km
  suggestedAt: {
    type: Date,
    default: Date.now
  }
});

const referralSchema = new mongoose.Schema({
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile',
    required: true
  },
  requirement: {
    title: String,
    description: String,
    symptoms: [symptomSchema],
    preferredSpecialization: [String],
    preferredLocation: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number] }
    },
    budgetRange: {
      min: Number,
      max: Number
    },
    urgency: {
      type: String,
      enum: ['low', 'medium', 'high', 'emergency'],
      default: 'medium'
    },
    preferredConsultationType: {
      type: String,
      enum: ['clinic', 'home', 'any'],
      default: 'any'
    },
    preferredGender: {
      type: String,
      enum: ['male', 'female', 'any'],
      default: 'any'
    },
    preferredLanguage: String
  },
  suggestedProfessionals: [doctorSuggestionSchema],
  selectedProfessional: {
    professionalId: mongoose.Schema.Types.ObjectId,
    type: { type: String, enum: ['doctor', 'physiotherapist'] },
    selectedAt: Date,
    selectionReason: String
  },
  status: {
    type: String,
    enum: [
      'draft',
      'submitted',
      'suggestions_generated',
      'professional_selected',
      'appointment_booked',
      'consultation_completed',
      'cancelled',
      'expired'
    ],
    default: 'draft'
  },
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  expiresAt: Date,
  metadata: {
    referralSource: String,
    deviceInfo: String,
    ipAddress: String
  }
}, {
  timestamps: true
});

referralSchema.index({ patientId: 1, status: 1 });
referralSchema.index({ 'requirement.preferredLocation': '2dsphere' });
referralSchema.index({ status: 1, createdAt: -1 });
referralSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index for auto-deletion

module.exports = mongoose.model('Referral', referralSchema);