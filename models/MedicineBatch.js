const mongoose = require('mongoose');

const medicineBatchSchema = new mongoose.Schema({
  medicineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Medicine',
    required: true
  },
  batchNumber: {
    type: String,
    required: true,
    trim: true
  },
  
  // Inventory
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  availableQuantity: {
    type: Number,
    required: true,
    min: 0
  },
  
  // Dates
  manufactureDate: {
    type: Date,
    required: true
  },
  expiryDate: {
    type: Date,
    required: true
  },
  purchaseDate: {
    type: Date,
    default: Date.now
  },
  
  // Pricing
  purchasePrice: {
    type: Number,
    required: true
  },
  sellingPrice: {
    type: Number,
    required: true
  },
  mrp: Number,
  
  // Supplier
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  supplierInvoice: String,
  
  // Location
  rackNumber: String,
  shelfNumber: String,
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  },
  isExpired: {
    type: Boolean,
    default: false
  },
  
  // Audit
  addedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  notes: String
}, {
  timestamps: true
});

medicineBatchSchema.index({ medicineId: 1, batchNumber: 1 });
medicineBatchSchema.index({ expiryDate: 1 });
medicineBatchSchema.index({ isExpired: 1, isActive: 1 });

// Update expired status
medicineBatchSchema.pre('save', function(next) {
  if (this.expiryDate && this.expiryDate < new Date()) {
    this.isExpired = true;
  }
  next();
});

module.exports = mongoose.model('MedicineBatch', medicineBatchSchema);