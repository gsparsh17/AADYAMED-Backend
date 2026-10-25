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
    type: { type: String, enum: ['clinic', 'home', 'video', 'all'], default: 'clinic' },
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

  clinicName: String,

  clinicAddress: {
    address: String,
    locality: String,
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
  videoCallFee: { type: Number, default: 0 },

  clinicConsultationEnabled: { type: Boolean, default: true },
  // No default on purpose: a missing flag means "decide from the fee" (see
  // getDoctorTypeEnabled). A `default: false` here was applied whenever an
  // older record was loaded, which switched off video/home visits for
  // doctors who had set those fees before these flags existed.
  homeVisitEnabled: { type: Boolean },
  teleconsultationEnabled: { type: Boolean },
  slotDurationMinutes: { type: Number, default: 30, min: 5, max: 180 },
  bookingWindowDays: { type: Number, default: 60, min: 1, max: 365 },
  minimumNoticeMinutes: { type: Number, default: 60, min: 0, max: 10080 },

  availability: [availabilitySlotSchema],

  languages: [String],
  about: String,
  services: [String],
  registrationCouncil: String,
  registrationYear: Number,
  awards: [{ title: String, year: Number }],
  memberships: [String],
  acceptedInsurance: [String],

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
doctorProfileSchema.index({ 'clinicAddress.city': 1, verificationStatus: 1 });
doctorProfileSchema.index({ 'clinicAddress.locality': 1, verificationStatus: 1 });
doctorProfileSchema.index({ languages: 1, verificationStatus: 1 });
doctorProfileSchema.index({ averageRating: -1 });

/* ------------------ Exports ------------------ */
const DoctorProfile = mongoose.model('DoctorProfile', doctorProfileSchema);

module.exports = DoctorProfile;
module.exports.availabilitySlotSchema = availabilitySlotSchema;
