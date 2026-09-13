const mongoose = require('mongoose');

const mrExpenseSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  expenseDate: { type: Date, required: true, default: Date.now },
  category: { type: String, enum: ['travel', 'daily_allowance', 'lodging', 'meals', 'local_conveyance', 'phone', 'meeting', 'other'], required: true },
  amount: { type: Number, min: 0, required: true },
  description: { type: String, trim: true },
  receiptUrl: { type: String, trim: true },
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'paid'], default: 'draft' },
  submittedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
  approvedAt: Date,
  managerComment: String,
}, { timestamps: true });

mrExpenseSchema.index({ profileId: 1, expenseDate: -1 });
mrExpenseSchema.index({ status: 1, submittedAt: -1 });

module.exports = mongoose.model('MRExpense', mrExpenseSchema);
