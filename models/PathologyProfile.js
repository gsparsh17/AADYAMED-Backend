const mongoose = require('mongoose');

const testSlotSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true
  },
  timeSlots: [{
    startTime: String,
    endTime: String,
    maxCapacity: { type: Number, default: 10 },
    bookedCount: { type: Number, default: 0 },
    isAvailable: { type: Boolean, default: true }
  }]
});

const testServiceSchema = new mongoose.Schema({
  testCode: String,
  testName: String,
  description: String,
  price: Number,
  fastingRequired: Boolean,
  reportTime: Number, // Hours to deliver report
  sampleType: String
});

const pathologyProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  labName: {
    type: String,
    required: true
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
  
  // Services
  services: [testServiceSchema],
  homeCollectionAvailable: {
    type: Boolean,
    default: false
  },
  homeCollectionCharges: Number,
  
  // Operating Hours
  operatingHours: {
    weekdays: {
      open: String,
      close: String
    },
    weekends: {
      open: String,
      close: String
    },
    holidays: [Date]
  },
  
  // Test Slots Management
  testSlots: [testSlotSchema],
  
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
  
  // Accreditation
  accreditation: [String],
  licenses: [{
    name: String,
    number: String,
    expiryDate: Date,
    documentUrl: String
  }],
  
  // Stats
  totalTestsConducted: {
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
  }
}, {
  timestamps: true
});

pathologyProfileSchema.index({ 'address.location': '2dsphere' });
pathologyProfileSchema.index({ verificationStatus: 1 });
pathologyProfileSchema.index({ 'services.testName': 'text', 'services.testCode': 'text' });

module.exports = mongoose.model('PathologyProfile', pathologyProfileSchema);