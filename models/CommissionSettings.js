const mongoose = require('mongoose');

const tieredRateSchema = new mongoose.Schema({
  minEarnings: Number,
  maxEarnings: Number,
  commissionRate: Number
});

const commissionSettingsSchema = new mongoose.Schema({
  // Default Commission Rates
  defaultDoctorCommission: {
    type: Number,
    default: 20,
    min: 0,
    max: 100
  },
  defaultPhysioCommission: {
    type: Number,
    default: 20,
    min: 0,
    max: 100
  },
  defaultPathologyCommission: {
    type: Number,
    default: 15,
    min: 0,
    max: 100
  },
  
  // Tiered Commission Structure
  tieredCommissionEnabled: {
    type: Boolean,
    default: false
  },
  tieredRates: [tieredRateSchema],
  
  // Minimum Fees
  minimumConsultationFee: {
    type: Number,
    default: 200,
    min: 0
  },
  minimumHomeVisitFee: {
    type: Number,
    default: 300,
    min: 0
  },
  
  // Payout Settings
  payoutThreshold: {
    type: Number,
    default: 1000,
    min: 0
  },
  payoutSchedule: {
    type: String,
    enum: ['weekly', 'biweekly', 'monthly'],
    default: 'monthly'
  },
  payoutDay: {
    type: Number,
    min: 1,
    max: 31,
    default: 1
  },
  
  // Cancellation Policy
  cancellationCommissionPolicy: {
    before24h: { type: Number, default: 0 },
    before12h: { type: Number, default: 25 },
    before6h: { type: Number, default: 50 },
    before2h: { type: Number, default: 75 },
    noShow: { type: Number, default: 100 }
  },
  
  // Platform Fees
  platformFee: {
    type: Number,
    default: 5,
    min: 0,
    max: 100
  },
  taxRate: {
    type: Number,
    default: 18,
    min: 0,
    max: 100
  },
  
  // Referral Bonuses
  referralBonusEnabled: {
    type: Boolean,
    default: false
  },
  patientReferralBonus: {
    type: Number,
    default: 100
  },
  doctorReferralBonus: {
    type: Number,
    default: 200
  },
  
  // Audit
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  version: {
    type: Number,
    default: 1
  },
  
  // Notes
  notes: String
}, {
  timestamps: true
});

// Ensure only one document exists
commissionSettingsSchema.statics.getSettings = async function() {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

module.exports = mongoose.model('CommissionSettings', commissionSettingsSchema);