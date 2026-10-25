const mongoose = require('mongoose');

const SIDES = ['left', 'right', 'bilateral', 'na'];
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const romSchema = new mongoose.Schema({
  joint: { type: String, required: true, trim: true, maxlength: 60 },
  movement: { type: String, required: true, trim: true, maxlength: 60 },
  side: { type: String, enum: SIDES, default: 'na' },
  activeDeg: { type: Number, min: -90, max: 360 },
  passiveDeg: { type: Number, min: -90, max: 360 },
  normalDeg: { type: Number, min: -90, max: 360 },
}, { _id: false });

const strengthSchema = new mongoose.Schema({
  muscleGroup: { type: String, required: true, trim: true, maxlength: 80 },
  side: { type: String, enum: SIDES, default: 'na' },
  grade: { type: Number, required: true, min: 0, max: 5 },
}, { _id: false });

const outcomeMeasureSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    enum: ['ODI', 'NDI', 'LEFS', 'DASH', 'KOOS', 'WOMAC', 'PSFS', 'OTHER'],
  },
  score: { type: Number, required: true, min: 0 },
  maxScore: { type: Number, min: 0 },
}, { _id: false });

const specialTestSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  result: { type: String, enum: ['positive', 'negative', 'inconclusive'], required: true },
  notes: { type: String, trim: true, maxlength: 500 },
}, { _id: false });

const physioAssessmentSchema = new mongoose.Schema({
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
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'PhysioTreatmentCourse' },
  type: {
    type: String,
    enum: ['initial', 'progress', 'discharge'],
    default: 'progress',
  },
  assessedAt: {
    type: Date,
    default: Date.now,
    validate: {
      validator: value => !value || value.getTime() <= Date.now() + FUTURE_SKEW_MS,
      message: 'assessedAt cannot be in the future',
    },
  },
  chiefComplaint: { type: String, trim: true, maxlength: 1000 },
  painScore: {
    rest: { type: Number, min: 0, max: 10 },
    activity: { type: Number, min: 0, max: 10 },
  },
  rom: [romSchema],
  strength: [strengthSchema],
  outcomeMeasures: [outcomeMeasureSchema],
  specialTests: [specialTestSchema],
  functionalNotes: { type: String, trim: true, maxlength: 3000 },
  plan: { type: String, trim: true, maxlength: 3000 },
  createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

physioAssessmentSchema.index({ physioId: 1, patientId: 1, assessedAt: -1 });
physioAssessmentSchema.index({ patientId: 1, assessedAt: -1 });

module.exports = mongoose.model('PhysioAssessment', physioAssessmentSchema);
