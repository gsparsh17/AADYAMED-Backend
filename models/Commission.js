const mongoose = require('mongoose');

const commissionSchema = new mongoose.Schema({
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    required: true
  },
  professionalId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'professionalType'
  },
  professionalType: {
    type: String,
    enum: ['doctor', 'physiotherapist', 'pathology'],
    required: true
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile'
  },
  
  // Financial Details
  consultationFee: Number,
  platformCommission: Number,
  professionalEarning: Number,
  commissionRate: Number, // Percentage
  
  // Payout Details
  payoutStatus: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'failed', 'cancelled'],
    default: 'pending'
  },
  payoutDate: Date,
  payoutMethod: {
    type: String,
    enum: ['bank_transfer', 'upi', 'cash', 'cheque']
  },
  transactionId: String,
  payoutReference: String,
  
  // Commission Cycle
  commissionCycle: {
    month: Number,
    year: Number,
    cycleNumber: String // Format: MMYYYY
  },
  
  // Adjustments
  adjustments: [{
    amount: Number,
    reason: String,
    type: { type: String, enum: ['bonus', 'deduction', 'refund'] },
    notes: String,
    appliedBy: mongoose.Schema.Types.ObjectId,
    appliedAt: Date
  }],
  adjustedAmount: {
    type: Number,
    default: 0
  },
  finalAmount: Number,
  
  // Audit
  calculatedAt: Date,
  paidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  paidAt: Date,
  
  // Dispute
  disputed: {
    type: Boolean,
    default: false
  },
  disputeReason: String,
  disputeResolvedAt: Date,
  
  // Metadata
  notes: String
}, {
  timestamps: true
});

commissionSchema.index({ professionalId: 1, payoutStatus: 1 });
commissionSchema.index({ commissionCycle: 1 });
commissionSchema.index({ appointmentId: 1 });
commissionSchema.index({ payoutDate: 1 });

// Calculate final amount
commissionSchema.pre('save', function(next) {
  if (this.isModified('platformCommission') || this.isModified('adjustedAmount')) {
    this.finalAmount = this.platformCommission + (this.adjustedAmount || 0);
  }
  next();
});

module.exports = mongoose.model('Commission', commissionSchema);