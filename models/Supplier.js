const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  companyName: String,
  
  // Contact
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true
  },
  alternatePhone: String,
  
  // Address
  address: String,
  city: String,
  state: String,
  pincode: String,
  country: {
    type: String,
    default: 'India'
  },
  
  // Business Details
  gstNumber: String,
  panNumber: String,
  drugLicenseNumber: String,
  
  // Products
  productsCategory: [String],
  creditPeriod: {
    type: Number,
    default: 30 // days
  },
  creditLimit: Number,
  
  // Bank Details
  bankName: String,
  accountNumber: String,
  ifscCode: String,
  accountHolderName: String,
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  
  // Contact Person
  contactPerson: {
    name: String,
    designation: String,
    phone: String,
    email: String
  },
  
  // Notes
  notes: String,
  
  // Audit
  addedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

supplierSchema.index({ name: 'text', companyName: 'text' });
supplierSchema.index({ isActive: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);