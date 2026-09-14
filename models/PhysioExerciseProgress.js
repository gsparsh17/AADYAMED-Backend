const mongoose = require('mongoose');

const physioExerciseProgressSchema = new mongoose.Schema({
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysioExercisePlan',
    required: true,
    index: true,
  },
  planItemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  exerciseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysioExercise',
    required: true,
    index: true,
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile',
    required: true,
    index: true,
  },
  physioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysiotherapistProfile',
    required: true,
    index: true,
  },
  performedAt: { type: Date, required: true, default: Date.now, index: true },
  setsCompleted: { type: Number, min: 0, max: 100, default: 0 },
  repsCompleted: { type: Number, min: 0, max: 5000, default: 0 },
  durationSec: { type: Number, min: 0, max: 86400, default: 0 },
  painBefore: { type: Number, min: 0, max: 10 },
  painAfter: { type: Number, min: 0, max: 10 },
  perceivedDifficulty: {
    type: String,
    enum: ['easy', 'about_right', 'hard'],
  },
  completed: { type: Boolean, default: true, index: true },
  notes: { type: String, trim: true, maxlength: 1000 },
  loggedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, { timestamps: true });

physioExerciseProgressSchema.index({ planId: 1, performedAt: -1 });
physioExerciseProgressSchema.index({ patientId: 1, exerciseId: 1, performedAt: -1 });

module.exports = mongoose.model('PhysioExerciseProgress', physioExerciseProgressSchema);
