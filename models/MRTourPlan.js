const mongoose = require('mongoose');

const planDaySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  area: { type: String, trim: true },
  objective: { type: String, trim: true },
  accountIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MRAccount' }],
}, { _id: false });

const mrTourPlanSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  month: { type: String, required: true },
  days: [planDaySchema],
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected'], default: 'draft' },
  submittedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
  approvedAt: Date,
  managerComment: String,
}, { timestamps: true });

mrTourPlanSchema.index({ profileId: 1, month: 1 }, { unique: true });
mrTourPlanSchema.index({ status: 1, month: 1 });

module.exports = mongoose.model('MRTourPlan', mrTourPlanSchema);
