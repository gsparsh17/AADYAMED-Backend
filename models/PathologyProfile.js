const mongoose = require('mongoose');

const testSlotSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  timeSlots: [{
    startTime: String,
    endTime: String,
    maxCapacity: { type: Number, default: 10 },
    bookedCount: { type: Number, default: 0 },
    isAvailable: { type: Boolean, default: true },
  }],
});

const testServiceSchema = new mongoose.Schema({
  testCode: { type: String, trim: true },
  testName: { type: String, trim: true },
  category: { type: String, trim: true },
  description: String,
  price: { type: Number, min: 0 },
  mrp: { type: Number, min: 0 },
  fastingRequired: { type: Boolean, default: false },
  fastingHours: { type: Number, default: 0, min: 0 },
  reportTime: Number,
  sampleType: String,
  preparation: String,
  methodology: String,
  homeCollectionEligible: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
});

const packageSchema = new mongoose.Schema({
  packageCode: { type: String, trim: true },
  packageName: { type: String, required: true, trim: true },
  description: String,
  testCodes: [{ type: String, trim: true }],
  price: { type: Number, required: true, min: 0 },
  mrp: { type: Number, min: 0 },
  fastingRequired: { type: Boolean, default: false },
  fastingHours: { type: Number, default: 0, min: 0 },
  reportTime: Number,
  isActive: { type: Boolean, default: true },
});

const pathologyProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  labName: { type: String, required: true },
  registrationNumber: String,
  profileImage: String,
  contactPerson: String,
  phone: { type: String, required: true },
  email: String,
  website: String,
  address: {
    street: String,
    city: String,
    state: String,
    pincode: String,
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] },
    },
  },
  services: [testServiceSchema],
  packages: [packageSchema],
  homeCollectionAvailable: { type: Boolean, default: false },
  homeCollectionCharges: { type: Number, default: 0, min: 0 },
  homeCollectionPincodes: [{ type: String, trim: true }],
  homeCollectionRadiusKm: { type: Number, default: 10, min: 0 },
  bookingSettings: {
    advanceBookingDays: { type: Number, default: 30, min: 1 },
    minimumNoticeHours: { type: Number, default: 2, min: 0 },
    cancellationWindowHours: { type: Number, default: 4, min: 0 },
  },
  operatingHours: {
    weekdays: { open: String, close: String },
    weekends: { open: String, close: String },
    holidays: [Date],
  },
  testSlots: [testSlotSchema],
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    default: 'pending',
  },
  adminNotes: String,
  verifiedAt: Date,
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  accreditation: [String],
  licenses: [{ name: String, number: String, expiryDate: Date, documentUrl: String }],
  totalTestsConducted: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
  totalReviews: { type: Number, default: 0 },
  commissionRate: { type: Number, default: 15, min: 0, max: 100 },
}, { timestamps: true });

pathologyProfileSchema.index({ 'address.location': '2dsphere' });
pathologyProfileSchema.index({ verificationStatus: 1 });
pathologyProfileSchema.index({ 'address.city': 1, verificationStatus: 1 });
pathologyProfileSchema.index({ 'homeCollectionPincodes': 1, verificationStatus: 1 });
// Keep the legacy single text index definition stable. MongoDB permits only one
// text index per collection; package/lab-name search is handled by regex in the
// diagnostics discovery endpoint to avoid a destructive index migration.
pathologyProfileSchema.index({ 'services.testName': 'text', 'services.testCode': 'text' });

module.exports = mongoose.model('PathologyProfile', pathologyProfileSchema);
