const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  payoutNumber: {
    type: String,
    required: true,
    unique: true
  },
  cycleNumber: {
    type: String,
    required: true,
    index: true
  },
  totalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  commissionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Commission'
  }],
  commissionsByProfessional: [{
    professionalType: {
      type: String,
      enum: ['doctor', 'physio', 'pathology'],
      required: true
    },
    professionalId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'commissionsByProfessional.professionalType'
    },
    commissions: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Commission'
    }],
    totalAmount: {
      type: Number,
      required: true,
      min: 0
    }
  }],
  payoutMethod: {
    type: String,
    enum: ['bank_transfer', 'upi', 'cash', 'cheque'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'failed', 'cancelled'],
    default: 'pending'
  },
  transactionId: String,
  payoutDate: {
    type: Date,
    default: Date.now
  },
  paidAt: Date,
  paymentDate: Date,
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  paidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  notes: String,
  failureReason: String
}, {
  timestamps: true
});

// Indexes
payoutSchema.index({ cycleNumber: 1, status: 1 });
payoutSchema.index({ payoutDate: -1 });
payoutSchema.index({ status: 1 });

const Payout = mongoose.model('Payout', payoutSchema);

module.exports = Payout;