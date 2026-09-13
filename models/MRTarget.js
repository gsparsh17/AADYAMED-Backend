const mongoose = require('mongoose');

const mrTargetSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  month: { type: String, required: true },
  callTarget: { type: Number, min: 0, default: 0 },
  doctorCallTarget: { type: Number, min: 0, default: 0 },
  chemistCallTarget: { type: Number, min: 0, default: 0 },
  pobTarget: { type: Number, min: 0, default: 0 },
  salesTarget: { type: Number, min: 0, default: 0 },
  workingDaysTarget: { type: Number, min: 0, default: 0 },
  setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
}, { timestamps: true });

mrTargetSchema.index({ profileId: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('MRTarget', mrTargetSchema);
