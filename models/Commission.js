const mongoose = require('mongoose');

const commissionSchema = new mongoose.Schema({
  // Optional since commissions also arise from pharmacy orders, which have no
  // appointment. Exactly one of appointmentId / pharmacyOrderId is set — see
  // the pre-validate hook at the bottom of this file.
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  pharmacyOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EPharmacyOrder',
    index: true
  },
  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PharmacyStore',
    index: true
  },

  // ✅ use refPath that matches registered mongoose model names
  professionalId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'professionalModel',
    required: true
  },

  // ✅ actual mongoose model name to populate
  professionalModel: {
    type: String,
    enum: ['DoctorProfile', 'PhysiotherapistProfile', 'PathologyProfile', 'PharmacyProfile'],
    required: true
  },

  // ✅ keep your existing business type
  professionalType: {
    type: String,
    enum: ['doctor', 'physio', 'pathology', 'pharmacy'],
    required: true
  },

  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile'
  },

  consultationFee: Number,
  platformCommission: Number,
  professionalEarning: Number,
  commissionRate: Number,

  payoutStatus: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'failed', 'cancelled'],
    default: 'pending'
  },
  payoutDate: Date,
  payoutMethod: {
    type: String,
    enum: ['bank_transfer', 'upi', 'cash', 'cheque', 'manual', 'bulk_transfer', 'card', 'netbanking', 'wallet']
  },
  transactionId: String,
  payoutReference: String,

  commissionCycle: {
    month: Number,
    year: Number,
    cycleNumber: String
  },

  adjustments: [{
    amount: Number,
    reason: String,
    type: { type: String, enum: ['bonus', 'deduction', 'refund'] },
    notes: String,
    appliedBy: mongoose.Schema.Types.ObjectId,
    appliedAt: Date
  }],
  adjustedAmount: { type: Number, default: 0 },
  finalAmount: Number,

  calculatedAt: Date,
  paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  paidAt: Date,

  disputed: { type: Boolean, default: false },
  disputeReason: String,
  disputeResolvedAt: Date,

  notes: String
}, { timestamps: true });

commissionSchema.index({ professionalId: 1, payoutStatus: 1 });
commissionSchema.index({ commissionCycle: 1 });
commissionSchema.index({ appointmentId: 1 });
commissionSchema.index({ payoutDate: 1 });

commissionSchema.pre('save', function(next) {
  if (this.isModified('platformCommission') || this.isModified('adjustedAmount')) {
    this.finalAmount = (this.platformCommission || 0) + (this.adjustedAmount || 0);
  }
  next();
});

commissionSchema.pre('validate', function (next) {
  if (!this.appointmentId && !this.pharmacyOrderId) {
    return next(new Error('A commission must reference an appointment or a pharmacy order'));
  }
  next();
});

// One commission per pharmacy order — the sparse index makes re-running
// settlement for an already-settled order a no-op rather than a duplicate.
commissionSchema.index({ pharmacyOrderId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Commission', commissionSchema);
