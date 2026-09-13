const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  // Basic Information
  name: { 
    type: String, 
    required: true, 
    trim: true 
  },
  phone: { 
    type: String, 
    required: true, 
    unique: true 
  },
  email: { 
    type: String, 
    lowercase: true, 
    sparse: true 
  },
  address: { 
    type: String, 
    trim: true 
  },
  
  // Customer Type & Identification
  customer_type: {
    type: String,
    enum: ['Patient', 'Walk-in', 'Regular', 'Corporate', 'Insurance'],
    default: 'Walk-in'
  },
  patient_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile',
    sparse: true // Allows null values but ensures uniqueness if provided
  },
  
  // Additional Details
  date_of_birth: { type: Date },
  gender: {
    type: String,
    enum: ['Male', 'Female', 'Other', 'Prefer not to say'],
    default: 'Prefer not to say'
  },
  
  // Medical Information (for patients)
  blood_group: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']
  },
  allergies: [String],
  medical_conditions: [String],
  
  // Contact Preferences
  contact_preferences: {
    sms: { type: Boolean, default: true },
    email: { type: Boolean, default: false },
    whatsapp: { type: Boolean, default: true }
  },
  
  // Loyalty/Points System
  loyalty_points: { type: Number, default: 0 },
  total_spent: { type: Number, default: 0 },
  
  // Status & Metadata
  is_active: { type: Boolean, default: true },
  notes: { type: String },
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, { 
  timestamps: true 
});

// Index for better query performance
customerSchema.index({ phone: 1 });
customerSchema.index({ email: 1 }, { sparse: true });
customerSchema.index({ patient_id: 1 }, { sparse: true });
customerSchema.index({ customer_type: 1 });
customerSchema.index({ is_active: 1 });

// Virtual for age calculation
customerSchema.virtual('age').get(function() {
  if (!this.date_of_birth) return null;
  const today = new Date();
  const birthDate = new Date(this.date_of_birth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
});

module.exports = mongoose.model('Customer', customerSchema);