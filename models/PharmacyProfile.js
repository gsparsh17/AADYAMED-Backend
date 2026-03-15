const mongoose = require('mongoose');

const pharmacyProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  pharmacyName: {
    type: String,
    required: true
  },
  licenseNumber: {
    type: String,
    required: true,
    unique: true
  },
  registrationNumber: String,
  profileImage: String,
  
  // Contact
  contactPerson: String,
  phone: {
    type: String,
    required: true
  },
  email: String,
  website: String,
  
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
  
  // Operating Hours
  operatingHours: {
    monday: { open: String, close: String, closed: { type: Boolean, default: false } },
    tuesday: { open: String, close: String, closed: { type: Boolean, default: false } },
    wednesday: { open: String, close: String, closed: { type: Boolean, default: false } },
    thursday: { open: String, close: String, closed: { type: Boolean, default: false } },
    friday: { open: String, close: String, closed: { type: Boolean, default: false } },
    saturday: { open: String, close: String, closed: { type: Boolean, default: false } },
    sunday: { open: String, close: String, closed: { type: Boolean, default: true } }
  },
  
  // Services
  deliveryAvailable: {
    type: Boolean,
    default: false
  },
  deliveryRadius: Number, // in km
  minimumOrderAmount: Number,
  deliveryCharge: Number,
  
  // Payment Methods
  paymentMethods: [{
    type: String,
    enum: ['cash', 'card', 'upi', 'insurance']
  }],
  
  // Verification
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    default: 'pending'
  },
  adminNotes: String,
  verifiedAt: Date,
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Licenses and Documents
  documents: [{
    name: String,
    number: String,
    expiryDate: Date,
    documentUrl: String
  }],
  
  // Stats
  totalOrders: {
    type: Number,
    default: 0
  },
  averageRating: {
    type: Number,
    default: 0
  },
  totalReviews: {
    type: Number,
    default: 0
  },
  
  // Commission
  commissionRate: {
    type: Number,
    default: 15
  },
  
  // Inventory stats
  totalMedicines: {
    type: Number,
    default: 0
  },
  lowStockAlerts: {
    type: Number,
    default: 0
  },
  expiredMedicines: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

pharmacyProfileSchema.index({ 'address.location': '2dsphere' });
pharmacyProfileSchema.index({ verificationStatus: 1 });
pharmacyProfileSchema.index({ pharmacyName: 'text' });

module.exports = mongoose.model('PharmacyProfile', pharmacyProfileSchema);