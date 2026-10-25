const mongoose = require('mongoose');

const physioPackageSchema = new mongoose.Schema({
  physioId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PhysiotherapistProfile',
    required: true,
    index: true,
  },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  description: { type: String, trim: true, maxlength: 2000 },
  sessionCount: { type: Number, required: true, min: 1, max: 100 },
  sessionDurationMin: { type: Number, min: 5, max: 480, default: 45 },
  visitType: {
    type: String,
    enum: ['clinic', 'home', 'video', 'any'],
    default: 'any',
  },
  price: { type: Number, required: true, min: 0 },
  validityDays: { type: Number, min: 1, max: 730, default: 90 },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true });

physioPackageSchema.index({ physioId: 1, isActive: 1, createdAt: -1 });

module.exports = mongoose.model('PhysioPackage', physioPackageSchema);
