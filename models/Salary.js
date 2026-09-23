const mongoose = require('mongoose');

// Payroll record for salaried hospital staff (front-desk, nursing, admin, etc.) —
// separate from independent professionals (doctors/pharmacies/labs), who earn
// via commission on Invoice, not a fixed salary. Referenced by the admin
// Income report (controllers/revenue.controller.js) to compute payroll expense
// against marketplace commission revenue.
const salarySchema = new mongoose.Schema({
  staffName: {
    type: String,
    required: true,
    trim: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  designation: String,
  gross_amount: {
    type: Number,
    required: true,
    min: 0
  },
  deductions: {
    type: Number,
    default: 0,
    min: 0
  },
  net_amount: {
    type: Number,
    required: true,
    min: 0
  },
  period_start: {
    type: Date,
    required: true
  },
  period_end: {
    type: Date,
    required: true
  },
  paid_date: Date,
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'cancelled'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'cash', 'cheque', 'upi']
  },
  paymentReference: String,
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  notes: String
}, { timestamps: true });

salarySchema.index({ status: 1, period_start: 1 });
salarySchema.index({ userId: 1, period_start: -1 });

module.exports = mongoose.model('Salary', salarySchema);
