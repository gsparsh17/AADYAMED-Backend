const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
}, { _id: false });

const mrAccountSchema = new mongoose.Schema({
  type: { type: String, enum: ['doctor', 'chemist', 'stockist', 'hospital'], required: true },
  name: { type: String, required: true, trim: true },
  specialty: { type: String, trim: true },
  registrationNumber: { type: String, trim: true },
  phone: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  organizationName: { type: String, trim: true },
  address: {
    line1: String,
    locality: String,
    city: String,
    state: String,
    pincode: String,
  },
  location: locationSchema,
  territoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRTerritory', default: null },
  assignedProfileIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile' }],
  classification: { type: String, enum: ['A', 'B', 'C', 'unclassified'], default: 'unclassified' },
  visitFrequencyPerMonth: { type: Number, min: 0, default: 1 },
  potentialValue: { type: Number, min: 0, default: 0 },
  isActive: { type: Boolean, default: true },
  // The same doctor or pharmacy's own Aadya Plus account, when they have one.
  linkedEntity: {
    kind: { type: String, enum: ['doctor', 'pharmacy'] },
    refId: { type: mongoose.Schema.Types.ObjectId },
    name: String,
    linkedAt: Date,
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
}, { timestamps: true });

mrAccountSchema.index({ type: 1, name: 1, 'address.city': 1 });
mrAccountSchema.index({ assignedProfileIds: 1, isActive: 1 });
mrAccountSchema.index({ territoryId: 1, isActive: 1 });

module.exports = mongoose.model('MRAccount', mrAccountSchema);
