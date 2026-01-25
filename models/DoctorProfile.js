const mongoose = require('mongoose');

/* ------------------ Shared Availability Sub-Schema ------------------ */
const availabilitySlotSchema = new mongoose.Schema({
  day: {
    type: String,
    enum: [
      'monday', 'tuesday', 'wednesday',
      'thursday', 'friday', 'saturday', 'sunday'
    ],
    required: true
  },
  slots: [{
    startTime: { type: String, required: true }, // "09:00"
    endTime: { type: String, required: true },
    type: { type: String, enum: ['clinic', 'home'], default: 'clinic' },
    maxPatients: { type: Number, default: 1 },
    isBooked: { type: Boolean, default: false }
  }]
}, { _id: false }); 
// _id false prevents auto-id for each day document

/* ------------------ Doctor Profile Schema ------------------ */
const doctorProfileSchema = new mongoose.Schema({
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

  consultationFee: { type: Number, required: true, min: 0 },
  homeVisitFee: { type: Number, default: 0 },

  availability: [availabilitySlotSchema],

  languages: [String],
  about: String,
  services: [String],

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
doctorProfileSchema.index({ 'clinicAddress.location': '2dsphere' });
doctorProfileSchema.index({ specialization: 1, verificationStatus: 1 });
doctorProfileSchema.index({ averageRating: -1 });

/* ------------------ Exports ------------------ */
const DoctorProfile = mongoose.model('DoctorProfile', doctorProfileSchema);

module.exports = DoctorProfile;
module.exports.availabilitySlotSchema = availabilitySlotSchema;
