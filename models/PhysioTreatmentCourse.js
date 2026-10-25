const mongoose = require('mongoose');

const physioTreatmentCourseSchema = new mongoose.Schema({
  physioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysiotherapistProfile',
    required: true,
    index: true,
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile',
    required: true,
    index: true,
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysioPackage',
  },
  // Package fields frozen at purchase time so later package edits do not
  // change what the patient bought.
  packageSnapshot: {
    name: String,
    sessionCount: Number,
    sessionDurationMin: Number,
    visitType: String,
    price: Number,
    validityDays: Number,
  },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  diagnosis: { type: String, trim: true, maxlength: 1000 },
  goals: [{ type: String, trim: true, maxlength: 300 }],
  totalSessions: { type: Number, required: true, min: 1, max: 100 },
  sessionsUsed: { type: Number, min: 0, default: 0 },
  // Appointments already counted into sessionsUsed (idempotency guard).
  countedAppointmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
  price: { type: Number, min: 0, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'refunded'],
    default: 'pending',
    index: true,
  },
  paymentMethod: { type: String, enum: ['cash', 'upi', 'online'] },
  paidAt: Date,
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled', 'expired'],
    default: 'active',
    index: true,
  },
  startDate: { type: Date, default: Date.now },
  expiresAt: Date,
  completedAt: Date,
  appointmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }],
  notes: { type: String, trim: true, maxlength: 2000 },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

physioTreatmentCourseSchema.virtual('sessionsLeft').get(function sessionsLeft() {
  return Math.max(0, Number(this.totalSessions || 0) - Number(this.sessionsUsed || 0));
});

physioTreatmentCourseSchema.index({ physioId: 1, status: 1, createdAt: -1 });
physioTreatmentCourseSchema.index({ patientId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PhysioTreatmentCourse', physioTreatmentCourseSchema);
