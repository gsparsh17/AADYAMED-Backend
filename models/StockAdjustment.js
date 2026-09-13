const mongoose = require('mongoose');

const stockAdjustmentSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', index: true },

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
  previousBatchQuantity: Number,
  newBatchQuantity: Number,
  
  // Adjustment Details
  adjustmentType: {
    type: String,
    enum: ['addition', 'deduction', 'damage', 'expiry', 'theft', 'correction', 'transfer', 'return'],
    required: true
  },
  reason: String,
  
  // Reference
  referenceType: {
    type: String,
    enum: ['sale', 'purchase', 'prescription', 'return', 'manual', 'transfer', 'grn', 'stocktake', 'online_order', 'other']
  },
  referenceId: mongoose.Schema.Types.ObjectId,
  sourceStoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore' },
  destinationStoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore' },
  
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
stockAdjustmentSchema.index({ organizationId: 1, storeId: 1, createdAt: -1 });

module.exports = mongoose.model('StockAdjustment', stockAdjustmentSchema);