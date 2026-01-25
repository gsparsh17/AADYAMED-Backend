const mongoose = require('mongoose');
const { availabilitySlotSchema } = require('./DoctorProfile');

const physiotherapistProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  name: { type: String, required: true },
  profileImage: String,

  gender: { type: String, enum: ['male', 'female', 'other'] },
  dateOfBirth: Date,

  specialization: [{ type: String, required: true }],

  qualifications: [{
    degree: String,
    university: String,
    year: Number,
    certificateUrl: String
  }],

  experienceYears: { type: Number, default: 0 },

  licenseNumber: { type: String, required: true },
  licenseDocument: String,

  clinicAddress: {
    address: String,
    city: String,
    state: String,
    pincode: String,
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },

  servesAreas: [String],

  consultationFee: { type: Number, required: true, min: 0 },
  homeVisitFee: { type: Number, required: true, min: 0 },

  availability: [availabilitySlotSchema], // ✅ Shared schema

  services: [{
    name: String,
    description: String,
    duration: Number,
    price: Number
  }],

  languages: [String],
  about: String,

  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    default: 'pending'
  },
  adminNotes: String,
  verifiedAt: Date,
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  totalEarnings: { type: Number, default: 0 },
  totalConsultations: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 },

  commissionRate: { type: Number, default: 20 },
  pendingCommission: { type: Number, default: 0 },
  paidCommission: { type: Number, default: 0 },

  contactNumber: String,
  emergencyContact: String,
  email: String,

  bankDetails: {
    accountName: String,
    accountNumber: String,
    ifscCode: String,
    bankName: String,
    branch: String
  }
}, { timestamps: true });

/* ------------------ Indexes ------------------ */
physiotherapistProfileSchema.index({ 'clinicAddress.location': '2dsphere' });
physiotherapistProfileSchema.index({ servesAreas: 1 });
physiotherapistProfileSchema.index({ verificationStatus: 1, averageRating: -1 });

module.exports = mongoose.model('PhysiotherapistProfile', physiotherapistProfileSchema);
