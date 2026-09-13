const mongoose = require('mongoose');

const testResultSchema = new mongoose.Schema({
  parameter: String,
  value: String,
  unit: String,
  normalRange: String,
  flag: { type: String, enum: ['normal', 'high', 'low', 'critical'] },
  notes: String,
}, { _id: false });

const sampleSchema = new mongoose.Schema({
  sampleType: String,
  barcode: String,
  collectionTime: Date,
  collectedBy: String,
  receivedAtLab: Date,
  rejectedAt: Date,
  rejectionReason: String,
  notes: String,
}, { _id: false });

const addressSchema = new mongoose.Schema({
  contactName: String,
  phone: String,
  line1: String,
  line2: String,
  landmark: String,
  city: String,
  state: String,
  pincode: String,
  location: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },
}, { _id: false });

const historySchema = new mongoose.Schema({
  status: String,
  note: String,
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  at: { type: Date, default: Date.now },
}, { _id: false });

const labTestSchema = new mongoose.Schema({
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  prescriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, index: true },
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile' },
  pathologyId: { type: mongoose.Schema.Types.ObjectId, ref: 'PathologyProfile', required: true, index: true },

  tests: [{
    testCode: String,
    testName: String,
    category: String,
    price: { type: Number, default: 0 },
    includedInPackage: { type: Boolean, default: false },
    sourcePackageCode: String,
    sampleType: String,
    fastingRequired: Boolean,
    reportTime: Number,
    status: {
      type: String,
      enum: ['pending', 'sample_collected', 'processing', 'ready_for_review', 'completed', 'cancelled'],
      default: 'pending',
    },
    requestedAt: { type: Date, default: Date.now },
    completedAt: Date,
    results: [testResultSchema],
  }],

  packages: [{
    packageCode: String,
    packageName: String,
    price: Number,
    testCodes: [String],
  }],

  scheduledDate: { type: Date, index: true },
  scheduledTime: String,
  startTime: String,
  endTime: String,
  type: {
    type: String,
    enum: ['lab_visit', 'home_collection'],
    required: true,
  },
  collectionAddress: String,
  collectionAddressDetails: addressSchema,
  patientInstructions: String,
  labInstructions: String,

  assignedPhlebotomistId: { type: mongoose.Schema.Types.ObjectId, ref: 'PathologyStaff' },
  collectionStatus: {
    type: String,
    enum: ['not_required', 'unassigned', 'assigned', 'en_route', 'arrived', 'collected', 'delivered_to_lab', 'failed'],
    default: function () { return this.type === 'home_collection' ? 'unassigned' : 'not_required'; },
    index: true,
  },
  assignedAt: Date,
  enRouteAt: Date,
  arrivedAt: Date,
  collectedAt: Date,
  deliveredToLabAt: Date,
  collectionFailureReason: String,

  sample: sampleSchema,
  results: [testResultSchema],
  resultNotes: String,
  reviewedByDoctor: { type: Boolean, default: false },
  reviewedAt: Date,

  reportUrl: String,
  reportFile: {
    path: { type: String, select: false },
    originalName: String,
    mimeType: String,
    size: Number,
    uploadedAt: Date,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: Date,
  },
  reportGeneratedAt: Date,
  reportViewedByPatient: { type: Boolean, default: false },
  reportViewedAt: Date,

  subtotal: { type: Number, default: 0 },
  collectionCharges: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded', 'partially_refunded'],
    default: 'pending',
    index: true,
  },
  paymentId: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  paymentDate: Date,
  refundId: String,
  refundPending: { type: Boolean, default: false },
  refundRequestedAt: Date,
  refundedAt: Date,
  refundFailureReason: String,

  status: {
    type: String,
    enum: ['requested', 'scheduled', 'sample_collected', 'processing', 'ready_for_review', 'completed', 'cancelled'],
    default: 'requested',
    index: true,
  },
  statusHistory: [historySchema],
  cancelledBy: { type: String, enum: ['patient', 'pathology', 'admin', 'system'] },
  cancellationReason: String,
  cancelledAt: Date,

  notifications: [{ type: String, sentAt: Date, recipient: String }],
  // Uniqueness is enforced by migrate:diagnostics. Keeping the schema index-free
  // avoids startup conflicts with legacy labTestNumber_1 index definitions.
  labTestNumber: { type: String },
  instructions: String,
  fastingRequired: Boolean,
  fastingHours: Number,
  specialInstructions: String,
  bookingSource: { type: String, enum: ['patient_web', 'patient_app', 'pathology', 'admin', 'prescription'], default: 'patient_web' },
}, { timestamps: true });

labTestSchema.index({ patientId: 1, createdAt: -1 }, { name: 'diagnostics_patient_history' });
labTestSchema.index({ pathologyId: 1, scheduledDate: 1, status: 1 }, { name: 'diagnostics_lab_schedule' });
labTestSchema.index({ pathologyId: 1, type: 1, collectionStatus: 1, scheduledDate: 1 }, { name: 'diagnostics_home_collection' });
labTestSchema.index({ appointmentId: 1 });
labTestSchema.index({ assignedPhlebotomistId: 1, scheduledDate: 1 });

labTestSchema.pre('save', async function(next) {
  if (!this.labTestNumber) {
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.labTestNumber = `LT${Date.now().toString().slice(-10)}${random}`;
  }
  next();
});

module.exports = mongoose.model('LabTest', labTestSchema);
