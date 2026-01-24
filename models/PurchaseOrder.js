const mongoose = require('mongoose');

const purchaseOrderItemSchema = new mongoose.Schema({
  medicineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  medicineName: String,
  quantity: {
    type: Number,
    required: true,
    min: 1
  },
  unit: String,
  purchasePrice: {
    type: Number,
    required: true
  },
  sellingPrice: Number,
  batchNumber: String,
  expiryDate: Date,
  
  // Received
  receivedQuantity: {
    type: Number,
    default: 0
  },
  damagedQuantity: {
    type: Number,
    default: 0
  },
  returnedQuantity: {
    type: Number,
    default: 0
  }
});

const purchaseOrderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    required: true,
    unique: true
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  
  // Items
  items: [purchaseOrderItemSchema],
  
  // Dates
  orderDate: {
    type: Date,
    default: Date.now
  },
  expectedDeliveryDate: Date,
  receivedDate: Date,
  
  // Financials
  subtotal: {
    type: Number,
    required: true
  },
  tax: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0
  },
  shippingCharges: {
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
  
  // Status
  status: {
    type: String,
    enum: ['draft', 'pending', 'approved', 'ordered', 'partially_received', 'received', 'cancelled', 'returned'],
    default: 'draft'
  },
  
  // Payment
  paymentStatus: {
    type: String,
    enum: ['pending', 'partial', 'paid', 'overdue'],
    default: 'pending'
  },
  paymentMethod: String,
  paymentDate: Date,
  
  // Documents
  invoiceNumber: String,
  deliveryChallan: String,
  
  // Notes
  notes: String,
  termsAndConditions: String,
  
  // Audit
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

purchaseOrderSchema.index({ orderNumber: 1 });
purchaseOrderSchema.index({ supplierId: 1, status: 1 });
purchaseOrderSchema.index({ orderDate: -1 });

// Generate order number
purchaseOrderSchema.pre('save', async function(next) {
  if (!this.orderNumber) {
    const count = await mongoose.model('PurchaseOrder').countDocuments();
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    this.orderNumber = `PO${year}${month}${(count + 1).toString().padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);