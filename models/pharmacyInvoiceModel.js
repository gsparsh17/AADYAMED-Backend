const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema({
  medicine_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
  name: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 }
}, { _id: false });

const pharmacyInvoiceSchema = new mongoose.Schema({
  prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription' },
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile' },
  items: {
    type: [invoiceItemSchema],
    validate: [items => Array.isArray(items) && items.length > 0, 'Invoice must contain at least one item']
  },
  total_amount: { type: Number, required: true, min: 0 },
  payment_mode: {
    type: String,
    required: true,
    enum: ['Cash', 'Card', 'Online', 'UPI']
  },
  status: {
    type: String,
    required: true,
    enum: ['Paid', 'Unpaid', 'Cancelled', 'Refunded'],
    default: 'Paid'
  },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

pharmacyInvoiceSchema.index({ patient_id: 1, createdAt: -1 });
pharmacyInvoiceSchema.index({ prescription_id: 1 });
pharmacyInvoiceSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PharmacyInvoice', pharmacyInvoiceSchema);
