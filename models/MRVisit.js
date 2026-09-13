const mongoose = require('mongoose');

const geoSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  accuracy: Number,
  capturedAt: Date,
}, { _id: false });

const mrVisitSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRAccount', required: true },
  visitDate: { type: Date, required: true, default: Date.now },
  status: { type: String, enum: ['planned', 'checked_in', 'completed', 'submitted', 'approved', 'rejected'], default: 'planned' },
  checkIn: geoSchema,
  checkOut: geoSchema,
  checkInDistanceMeters: Number,
  geofenceStatus: { type: String, enum: ['inside', 'outside', 'unknown'], default: 'unknown' },
  callType: { type: String, enum: ['solo', 'joint'], default: 'solo' },
  jointWithProfileIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile' }],
  productsDiscussed: [{ productName: String, brand: String, notes: String }],
  samples: [{ productName: String, batchNumber: String, quantity: { type: Number, min: 0 } }],
  gifts: [{ itemName: String, quantity: { type: Number, min: 0 } }],
  discussionNotes: { type: String, trim: true },
  doctorFeedback: { type: String, trim: true },
  nextVisitDate: Date,
  pobAmount: { type: Number, min: 0, default: 0 },
  pobOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRPOB', default: null },
  submittedAt: Date,
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
  approvedAt: Date,
  managerComment: { type: String, trim: true },
  inventoryPostedAt: Date,
}, { timestamps: true });

mrVisitSchema.index({ profileId: 1, visitDate: -1 });
mrVisitSchema.index({ accountId: 1, visitDate: -1 });
mrVisitSchema.index({ status: 1, submittedAt: -1 });

module.exports = mongoose.model('MRVisit', mrVisitSchema);
