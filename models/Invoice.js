const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  unitPrice: {
    type: Number,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  taxRate: {
    type: Number,
    default: 0
  },
  taxAmount: {
    type: Number,
    default: 0
  }
});

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: {
    type: String,
    required: true,
    unique: true
  },
  invoiceType: {
    type: String,
    enum: ['appointment', 'pharmacy', 'lab_test', 'package', 'other'],
    required: true
  },
  
  // Reference
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment'
  },
  pharmacySaleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PharmacySale'
  },
  labTestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabTest'
  },
  patientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PatientProfile',
    required: true
  },
  
  // Customer Details
  customerName: {
    type: String,
    required: true
  },
  customerPhone: String,
  customerEmail: String,
  customerAddress: String,
  
  // Items
  items: [invoiceItemSchema],
  
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
  totalAmount: {
    type: Number,
    required: true
  },
  amountPaid: {
    type: Number,
    default: 0
  },
  balanceDue: {
    type: Number,
    default: 0
  },
  
  // Dates
  invoiceDate: {
    type: Date,
    default: Date.now
  },
  dueDate: Date,
  paymentDate: Date,
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'sent', 'paid', 'partial', 'overdue', 'cancelled', 'refunded'],
    default: 'draft'
  },
  
  // Payment
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'upi', 'online', 'insurance', 'credit']
  },
  paymentReference: String,
  
  // Commission
  commissionIncluded: {
    type: Boolean,
    default: false
  },
  commissionAmount: {
    type: Number,
    default: 0
  },
  
  // Documents
  pdfUrl: String,
  qrCode: String,
  
  // Notes
  notes: String,
  termsAndConditions: String,
  
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

invoiceSchema.index({ invoiceNumber: 1 });
invoiceSchema.index({ patientId: 1, invoiceDate: -1 });
invoiceSchema.index({ status: 1, dueDate: 1 });
invoiceSchema.index({ invoiceType: 1 });

// Generate invoice number
invoiceSchema.pre('save', async function(next) {
  if (!this.invoiceNumber) {
    const count = await mongoose.model('Invoice').countDocuments();
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.invoiceNumber = `INV${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }
  
  // Calculate totals
  if (this.isModified('items')) {
    this.subtotal = this.items.reduce((sum, item) => sum + item.amount, 0);
    this.tax = this.items.reduce((sum, item) => sum + (item.taxAmount || 0), 0);
    this.totalAmount = this.subtotal + this.tax - this.discount;
    this.balanceDue = this.totalAmount - this.amountPaid;
  }
  
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);