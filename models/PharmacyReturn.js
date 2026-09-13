const mongoose = require('mongoose');

const returnItemSchema = new mongoose.Schema({
  saleItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  medicineName: String,
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true, min: 0 },
  taxableAmount: { type: Number, default: 0, min: 0 },
  taxAmount: { type: Number, default: 0, min: 0 },
  refundAmount: { type: Number, required: true, min: 0 },
  reason: String,
  restockable: { type: Boolean, default: true },
  batchAllocations: [{
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
    quantity: { type: Number, min: 0 },
  }],
});

const pharmacyReturnSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', required: true, index: true },
  returnNumber: { type: String, required: true, unique: true },
  saleId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacySale', required: true, index: true },
  items: { type: [returnItemSchema], validate: [v => v?.length > 0, 'Return must contain at least one item'] },
  subtotal: { type: Number, default: 0, min: 0 },
  taxRefund: { type: Number, default: 0, min: 0 },
  totalRefund: { type: Number, required: true, min: 0 },
  refundMethod: { type: String, enum: ['cash', 'card', 'upi', 'online', 'credit_note'], default: 'cash' },
  refundReference: String,
  status: { type: String, enum: ['completed', 'cancelled'], default: 'completed' },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

pharmacyReturnSchema.index({ organizationId: 1, storeId: 1, createdAt: -1 });
pharmacyReturnSchema.index({ saleId: 1, createdAt: -1 });

pharmacyReturnSchema.pre('validate', async function(next) {
  if (!this.returnNumber) {
    const suffix = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
    this.returnNumber = `RET-${suffix}`;
  }
  next();
});

module.exports = mongoose.model('PharmacyReturn', pharmacyReturnSchema);
