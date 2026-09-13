const mongoose = require('mongoose');

const transferItemSchema = new mongoose.Schema({
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  medicineName: String,
  requestedQuantity: { type: Number, required: true, min: 1 },
  dispatchedQuantity: { type: Number, default: 0, min: 0 },
  receivedQuantity: { type: Number, default: 0, min: 0 },
  batchAllocations: [{
    sourceBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
    destinationBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
    batchNumber: String,
    quantity: { type: Number, min: 0 },
    expiryDate: Date,
    manufactureDate: Date,
    purchasePrice: Number,
    sellingPrice: Number,
    mrp: Number,
  }],
});

const stockTransferSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  transferNumber: { type: String, required: true, unique: true },
  sourceStoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', required: true, index: true },
  destinationStoreId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', required: true, index: true },
  items: { type: [transferItemSchema], validate: [v => v?.length > 0, 'Transfer must contain at least one item'] },
  status: {
    type: String,
    enum: ['requested', 'approved', 'dispatched', 'received', 'rejected', 'cancelled'],
    default: 'requested',
    index: true,
  },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  dispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  requestedAt: { type: Date, default: Date.now },
  approvedAt: Date,
  dispatchedAt: Date,
  receivedAt: Date,
  notes: String,
}, { timestamps: true });

stockTransferSchema.index({ organizationId: 1, sourceStoreId: 1, createdAt: -1 });
stockTransferSchema.index({ organizationId: 1, destinationStoreId: 1, createdAt: -1 });

stockTransferSchema.pre('validate', async function(next) {
  if (!this.transferNumber) {
    const suffix = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
    this.transferNumber = `TRF-${suffix}`;
  }
  next();
});

module.exports = mongoose.model('StockTransfer', stockTransferSchema);
