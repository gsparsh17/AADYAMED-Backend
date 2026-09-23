const mongoose = require('mongoose');

// A shared, read-only drug reference list — NOT per-pharmacy stock. Every
// pharmacy searches this when adding a medicine to autofill name/category/
// composition, then creates their own scoped Medicine with their own price
// and stock. This collection carries no organizationId/storeId on purpose.
const medicineCatalogSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, index: true },
  genericName: { type: String, trim: true },
  brandName: { type: String, trim: true },
  category: {
    type: String,
    enum: ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'ointment', 'drops', 'inhaler', 'other'],
    default: 'other'
  },
  strength: String,
  composition: String,
  manufacturer: String,
  hsnCode: String,
  gstRate: Number,
  prescriptionRequired: { type: Boolean, default: false },
  source: { type: String, default: 'import' }
}, { timestamps: true });

medicineCatalogSchema.index({ name: 'text', genericName: 'text', brandName: 'text', composition: 'text' });

module.exports = mongoose.model('MedicineCatalog', medicineCatalogSchema);
