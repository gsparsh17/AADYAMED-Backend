const mongoose = require('mongoose');

const mrProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  employeeCode: { type: String, required: true, trim: true, uppercase: true },
  designation: { type: String, enum: ['MR', 'ABM', 'RBM', 'ZSM'], required: true, default: 'MR' },
  managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
  headquarters: { type: String, trim: true },
  division: { type: String, trim: true },
  state: { type: String, trim: true },
  zone: { type: String, trim: true },
  territoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MRTerritory' }],
  productLine: { type: String, trim: true },
  dateOfJoining: Date,
  reportingEnabled: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  notes: { type: String, trim: true },
}, { timestamps: true });

mrProfileSchema.index({ userId: 1 }, { unique: true });
mrProfileSchema.index({ employeeCode: 1 }, { unique: true });
mrProfileSchema.index({ managerId: 1, isActive: 1 });
mrProfileSchema.index({ designation: 1, state: 1, headquarters: 1 });

module.exports = mongoose.model('MRProfile', mrProfileSchema);
