const mongoose = require('mongoose');

const mrPOBSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, trim: true, uppercase: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRAccount', required: true },
  orderDate: { type: Date, default: Date.now },
  items: [{ productName: { type: String, required: true }, sku: String, quantity: { type: Number, min: 1, required: true }, rate: { type: Number, min: 0, required: true }, amount: { type: Number, min: 0, required: true } }],
  totalAmount: { type: Number, min: 0, required: true },
  status: { type: String, enum: ['placed', 'accepted', 'fulfilled', 'cancelled'], default: 'placed' },
  notes: String,
}, { timestamps: true });

mrPOBSchema.index({ orderNumber: 1 }, { unique: true });
mrPOBSchema.index({ profileId: 1, orderDate: -1 });
mrPOBSchema.index({ accountId: 1, orderDate: -1 });

module.exports = mongoose.model('MRPOB', mrPOBSchema);
