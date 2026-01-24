const mongoose = require('mongoose');

const medicineSchema = new mongoose.Schema({
  medicineName: {
    type: String,
    required: true,
    trim: true
  },
  genericName: String,
  brandName: String,
  category: {
    type: String,
    enum: ['tablet', 'capsule', 'syrup', 'injection', 'ointment', 'drops', 'inhaler', 'other'],
    required: true
  },
  description: String,
  dosageForm: {
    type: String,
    enum: ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'ointment', 'drops', 'inhaler', 'powder', 'other']
  },
  strength: String, // e.g., "500mg", "10mg/ml"
  unit: {
    type: String,
    enum: ['mg', 'g', 'ml', 'tablet', 'capsule', 'bottle', 'tube', 'pack', 'other'],
    required: true
  },
  
  // Inventory
  quantity: {
    type: Number,
    default: 0,
    min: 0
  },
  reorderLevel: {
    type: Number,
    default: 10
  },
  expiryAlertDays: {
    type: Number,
    default: 30
  },
  
  // Pricing
  purchasePrice: Number,
  sellingPrice: {
    type: Number,
    required: true,
    min: 0
  },
  taxRate: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  
  // Manufacturer
  manufacturer: String,
  manufacturerAddress: String,
  manufacturerContact: String,
  
  // Prescription
  prescriptionRequired: {
    type: Boolean,
    default: true
  },
  schedule: {
    type: String,
    enum: ['Schedule H', 'Schedule H1', 'Schedule X', 'Non-Scheduled']
  },
  
  // Storage
  storageConditions: {
    type: String,
    enum: ['room_temp', 'refrigerated', 'freezer', 'protected_from_light']
  },
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Metadata
  barcode: String,
  hsnCode: String,
  composition: String,
  uses: [String],
  sideEffects: [String],
  contraindications: [String],
  
  // Images
  medicineImage: String,
  
  // Audit
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

medicineSchema.index({ medicineName: 'text', genericName: 'text', brandName: 'text' });
medicineSchema.index({ category: 1, isActive: 1 });
medicineSchema.index({ quantity: 1 });

module.exports = mongoose.model('Medicine', medicineSchema);