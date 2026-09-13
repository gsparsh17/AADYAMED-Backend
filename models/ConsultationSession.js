const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['patient', 'doctor', 'physio', 'admin'], required: true },
  joinedAt: { type: Date, default: Date.now },
  leftAt: Date,
  lastSeenAt: { type: Date, default: Date.now }
}, { _id: false });

const consultationSessionSchema = new mongoose.Schema({
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    required: true,
    unique: true
  },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
  professionalType: { type: String, enum: ['doctor', 'physio'], required: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile', index: true },
  physioId: { type: mongoose.Schema.Types.ObjectId, ref: 'PhysiotherapistProfile', index: true },
  consultationType: { type: String, enum: ['clinic', 'home', 'video'], required: true },

  provider: { type: String, enum: ['jitsi', 'external', 'in_person'], default: 'in_person' },
  // Never expose the room URL through ordinary appointment/session reads.
  roomId: { type: String, select: false },
  roomUrl: { type: String, select: false },

  status: {
    type: String,
    enum: ['scheduled', 'patient_waiting', 'professional_ready', 'in_progress', 'ended', 'cancelled', 'no_show'],
    default: 'scheduled',
    index: true
  },
  patientCheckedInAt: Date,
  professionalCheckedInAt: Date,
  startedAt: Date,
  endedAt: Date,
  lastActivityAt: Date,
  participants: [participantSchema],

  consent: {
    teleconsultationAccepted: { type: Boolean, default: false },
    acceptedAt: Date,
    privacyNoticeVersion: String
  },

  clinicalSummary: {
    chiefComplaint: [String],
    diagnosis: [String],
    notes: String,
    advice: String,
    outcome: { type: String, enum: ['resolved', 'improved', 'ongoing', 'referred', 'emergency_referral', 'unknown'], default: 'unknown' },
    followUpRequired: { type: Boolean, default: false },
    followUpDate: Date,
    followUpNotes: String
  },

  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

consultationSessionSchema.index({ patientId: 1, createdAt: -1 });
consultationSessionSchema.index({ doctorId: 1, createdAt: -1 });
consultationSessionSchema.index({ physioId: 1, createdAt: -1 });
consultationSessionSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('ConsultationSession', consultationSessionSchema);
