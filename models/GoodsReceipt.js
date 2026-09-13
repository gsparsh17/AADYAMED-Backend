const mongoose = require('mongoose');

const goodsReceiptItemSchema = new mongoose.Schema({
  purchaseOrderItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  medicineName: String,
  batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
  batchNumber: { type: String, required: true, trim: true },
  orderedQuantity: { type: Number, min: 0, default: 0 },
  receivedQuantity: { type: Number, required: true, min: 0 },
  acceptedQuantity: { type: Number, required: true, min: 0 },
  damagedQuantity: { type: Number, default: 0, min: 0 },
  purchasePrice: { type: Number, required: true, min: 0 },
  sellingPrice: { type: Number, required: true, min: 0 },
  mrp: { type: Number, min: 0 },
  taxRate: { type: Number, default: 0, min: 0 },
  expiryDate: { type: Date, required: true },
  manufactureDate: Date,
}, { _id: true });

const goodsReceiptSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', required: true, index: true },
  grnNumber: { type: String, required: true, unique: true },
  purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  supplierInvoiceNumber: String,
  supplierInvoiceDate: Date,
  receivedDate: { type: Date, default: Date.now },
  items: { type: [goodsReceiptItemSchema], validate: [v => v?.length > 0, 'GRN must have at least one item'] },
  acceptedValue: { type: Number, default: 0, min: 0 },
  damagedValue: { type: Number, default: 0, min: 0 },
  notes: String,
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });

goodsReceiptSchema.index({ organizationId: 1, storeId: 1, receivedDate: -1 });
goodsReceiptSchema.index({ purchaseOrderId: 1, receivedDate: -1 });

goodsReceiptSchema.pre('validate', async function(next) {
  if (!this.grnNumber) {
    const suffix = `${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 100).toString().padStart(2, '0')}`;
    this.grnNumber = `GRN-${suffix}`;
  }
  next();
});

module.exports = mongoose.model('GoodsReceipt', goodsReceiptSchema);
