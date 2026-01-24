const mongoose = require('mongoose');

const medicalHistorySchema = new mongoose.Schema({
  condition: String,
  diagnosedDate: Date,
  status: String,
  notes: String
});

const allergySchema = new mongoose.Schema({
  allergen: String,
  reaction: String,
  severity: { type: String, enum: ['mild', 'moderate', 'severe'] }
});

const patientProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  profileImage: String,
  gender: {
    type: String,
    enum: ['male', 'female', 'other']
  },
  dateOfBirth: {
    type: Date,
    required: true
  },
  age: Number,
  bloodGroup: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']
  },
  height: Number, // in cm
  weight: Number, // in kg
  
  // Contact
  phone: {
    type: String,
    required: true
  },
  alternatePhone: String,
  emergencyContact: {
    name: String,
    relationship: String,
    phone: String
  },
  
  // Address
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },
  
  // Medical Information
  medicalHistory: [medicalHistorySchema],
  allergies: [allergySchema],
  currentMedications: [{
    name: String,
    dosage: String,
    frequency: String,
    prescribedBy: String,
    startDate: Date,
    endDate: Date
  }],
  chronicConditions: [String],
  
  // Preferences
  preferences: {
    preferredConsultationType: {
      type: String,
      enum: ['clinic', 'home', 'both'],
      default: 'clinic'
    },
    preferredLanguage: String,
    notificationPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      push: { type: Boolean, default: true }
    }
  },
  
  // Insurance
  insuranceProvider: String,
  insuranceNumber: String,
  policyExpiry: Date,
  
  // Stats
  totalConsultations: {
    type: Number,
    default: 0
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  lastConsultation: Date
}, {
  timestamps: true
});

patientProfileSchema.index({ 'address.location': '2dsphere' });
patientProfileSchema.pre('save', function(next) {
  if (this.dateOfBirth) {
    const ageDiff = Date.now() - this.dateOfBirth.getTime();
    const ageDate = new Date(ageDiff);
    this.age = Math.abs(ageDate.getUTCFullYear() - 1970);
  }
  next();
});

module.exports = mongoose.model('PatientProfile', patientProfileSchema);