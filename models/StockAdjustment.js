const mongoose = require('mongoose');

const stockAdjustmentSchema = new mongoose.Schema({
  medicineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicineBatch'
  },
  
  // Quantities
  previousQuantity: {
    type: Number,
    required: true
  },
  adjustmentQuantity: {
    type: Number,
    required: true
  },
  newQuantity: {
    type: Number,
    required: true
  },
  
  // Adjustment Details
  adjustmentType: {
    type: String,
    enum: ['addition', 'deduction', 'damage', 'expiry', 'theft', 'correction', 'transfer'],
    required: true
  },
  reason: String,
  
  // Reference
  referenceType: {
    type: String,
    enum: ['sale', 'purchase', 'prescription', 'return', 'manual', 'other']
  },
  referenceId: mongoose.Schema.Types.ObjectId,
  
  // Notes
  notes: String,
  
  // Audit
  adjustedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

stockAdjustmentSchema.index({ medicineId: 1, createdAt: -1 });
stockAdjustmentSchema.index({ adjustmentType: 1 });

module.exports = mongoose.model('StockAdjustment', stockAdjustmentSchema);