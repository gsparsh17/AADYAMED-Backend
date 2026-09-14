const mongoose = require('mongoose');

const physioExerciseSchema = new mongoose.Schema({
  ownerPhysioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysiotherapistProfile',
    required: true,
    index: true,
  },
  createdByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, trim: true, maxlength: 1200 },
  category: { type: String, trim: true, maxlength: 100 },
  bodyPart: { type: String, trim: true, maxlength: 100 },
  difficulty: {
    type: String,
    enum: ['easy', 'moderate', 'hard'],
    default: 'moderate',
  },
  equipment: [{ type: String, trim: true, maxlength: 120 }],
  instructions: [{ type: String, trim: true, maxlength: 500 }],
  precautions: [{ type: String, trim: true, maxlength: 500 }],
  defaultSets: { type: Number, min: 0, max: 100, default: 0 },
  defaultReps: { type: Number, min: 0, max: 1000, default: 0 },
  defaultDurationSec: { type: Number, min: 0, max: 86400, default: 0 },
  defaultFrequency: { type: String, trim: true, maxlength: 120 },
  imageUrl: { type: String, trim: true },
  videoUrl: { type: String, trim: true },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

physioExerciseSchema.index({ ownerPhysioId: 1, isActive: 1, name: 1 });

module.exports = mongoose.model('PhysioExercise', physioExerciseSchema);
