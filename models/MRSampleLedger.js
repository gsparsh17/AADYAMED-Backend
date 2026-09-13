const mongoose = require('mongoose');

const mrSampleLedgerSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  transactionDate: { type: Date, default: Date.now },
  itemType: { type: String, enum: ['sample', 'gift'], default: 'sample', required: true },
  productName: { type: String, required: true, trim: true },
  batchNumber: { type: String, trim: true },
  transactionType: { type: String, enum: ['issue', 'consume', 'return', 'adjustment'], required: true },
  adjustmentDirection: { type: String, enum: ['in', 'out'], default: undefined },
  quantity: { type: Number, min: 0.001, required: true },
  visitId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRVisit', default: null },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRAccount', default: null },
  notes: String,
  sourceKey: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
}, { timestamps: true });

mrSampleLedgerSchema.index({ profileId: 1, itemType: 1, productName: 1, transactionDate: -1 });
mrSampleLedgerSchema.index({ visitId: 1 });
mrSampleLedgerSchema.index({ sourceKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('MRSampleLedger', mrSampleLedgerSchema);
