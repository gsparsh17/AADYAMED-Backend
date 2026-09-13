const mongoose = require('mongoose');

const pharmacySaleItemSchema = new mongoose.Schema({
  medicineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MedicineBatch'
  },
  batchAllocations: [{
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicineBatch' },
    quantity: { type: Number, min: 0 },
    purchasePrice: { type: Number, min: 0 }
  }],
  medicineName: String,
  genericName: String,
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  unit: String,
  sellingPrice: {
    type: Number,
    required: true
  },
  discount: {
    type: Number,
    default: 0
  },
  taxRate: {
    type: Number,
    default: 0
  },
  priceIncludesTax: { type: Boolean, default: true },
  hsnCode: String,
  taxableAmount: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  costAmount: { type: Number, default: 0 },
  returnedQuantity: { type: Number, default: 0, min: 0 },
  totalAmount: {
    type: Number,
    required: true
  }
});

const pharmacySaleSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PharmacyStore', index: true },

  saleNumber: {
    type: String,
    required: true,
    unique: true
  },
  
  // Customer
  customerType: {
    type: String,
    enum: ['patient', 'walkin', 'online'],
    default: 'walkin'
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile'
  },
  prescriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  
  // Customer Details
  customerName: String,
  customerPhone: String,
  customerEmail: String,
  customerAddress: String,
  
  // Items
  items: [pharmacySaleItemSchema],
  
  // Prescription Info
  prescriptionRequired: {
    type: Boolean,
    default: false
  },
  prescriptionNumber: String,
  prescribingDoctor: String,
  
  // Financials
  subtotal: {
    type: Number,
    required: true
  },
  discount: {
    type: Number,
    default: 0
  },
  tax: {
    type: Number,
    default: 0
  },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  taxMode: { type: String, enum: ['intrastate', 'interstate'], default: 'intrastate' },
  costOfGoods: { type: Number, default: 0 },
  grossProfit: { type: Number, default: 0 },
  returnedAmount: { type: Number, default: 0 },
  returnedSubtotal: { type: Number, default: 0 },
  returnedTax: { type: Number, default: 0 },
  returnedCost: { type: Number, default: 0 },
  roundOff: {
    type: Number,
    default: 0
  },
  totalAmount: {
    type: Number,
    required: true
  },
  paidAmount: {
    type: Number,
    default: 0
  },
  balanceAmount: {
    type: Number,
    default: 0
  },
  
  // Payment
  paymentStatus: {
    type: String,
    enum: ['pending', 'partial', 'paid', 'refunded'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'upi', 'online', 'insurance', 'credit']
  },
  paymentReference: String,
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'pending', 'dispensed', 'partially_returned', 'cancelled', 'returned'],
    default: 'draft'
  },
  
  // Dates
  saleDate: {
    type: Date,
    default: Date.now
  },
  deliveryDate: Date,
  prescriptionDate: Date,
  
  // Notes
  notes: String,
  deliveryInstructions: String,
  
  // Audit
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  dispensedAt: Date,
  invoiceNumber: String,
  dispensedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  deliveredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

pharmacySaleSchema.index({ customerPhone: 1 });
pharmacySaleSchema.index({ saleDate: -1 });
pharmacySaleSchema.index({ patientId: 1, prescriptionId: 1 });
pharmacySaleSchema.index({ organizationId: 1, storeId: 1, saleDate: -1 });

// Generate sale number
pharmacySaleSchema.pre('validate', async function(next) {
  if (!this.saleNumber) {
    const count = await mongoose.model('PharmacySale').countDocuments();
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.saleNumber = `PS${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('PharmacySale', pharmacySaleSchema);