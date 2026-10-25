const mongoose = require('mongoose');

const exercisePlanItemSchema = new mongoose.Schema({
  exerciseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysioExercise',
    required: true,
  },
  sets: { type: Number, min: 0, max: 100, default: 0 },
  reps: { type: Number, min: 0, max: 1000, default: 0 },
  durationSec: { type: Number, min: 0, max: 86400, default: 0 },
  // Free-text frequency kept for backward compatibility; structured dosing
  // fields below drive adherence calculations when present.
  frequency: { type: String, trim: true, maxlength: 120 },
  holdSec: { type: Number, min: 0, max: 3600 },
  restSec: { type: Number, min: 0, max: 3600 },
  side: { type: String, enum: ['left', 'right', 'both', 'na'] },
  load: { type: String, trim: true, maxlength: 120 },
  timesPerDay: { type: Number, min: 1, max: 6 },
  daysPerWeek: { type: Number, min: 1, max: 7 },
  notes: { type: String, trim: true, maxlength: 1000 },
  sortOrder: { type: Number, min: 0, default: 0 },
}, { _id: true });

const physioExercisePlanSchema = new mongoose.Schema({
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
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    index: true,
  },
  title: {
    type: String,
    trim: true,
    maxlength: 160,
    default: 'Physiotherapy exercise plan',
  },
  goals: [{ type: String, trim: true, maxlength: 300 }],
  instructions: { type: String, trim: true, maxlength: 2000 },
  exercises: {
    type: [exercisePlanItemSchema],
    validate: {
      validator(value) {
        if (!Array.isArray(value) || value.length === 0) return false;
        const ids = value.map(item => String(item.exerciseId || ''));
        return ids.length === new Set(ids).size;
      },
      message: 'At least one unique exercise is required',
    },
  },
  startDate: { type: Date, default: Date.now },
  endDate: Date,
  status: {
    type: String,
    enum: ['active', 'completed', 'cancelled'],
    default: 'active',
    index: true,
  },
  createdByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

physioExercisePlanSchema.index({ patientId: 1, status: 1, createdAt: -1 });
physioExercisePlanSchema.index({ physioId: 1, patientId: 1, createdAt: -1 });

module.exports = mongoose.model('PhysioExercisePlan', physioExercisePlanSchema);
