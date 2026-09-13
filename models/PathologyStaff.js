const mongoose = require('mongoose');

const pathologyStaffSchema = new mongoose.Schema({
  pathologyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PathologyProfile',
    required: true,
    index: true,
  },
  employeeCode: { type: String, trim: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  role: {
    type: String,
    enum: ['phlebotomist', 'technician', 'receptionist'],
    default: 'phlebotomist',
  },
  servicePincodes: [{ type: String, trim: true }],
  isActive: { type: Boolean, default: true },
  notes: String,
}, { timestamps: true });

pathologyStaffSchema.index({ pathologyId: 1, employeeCode: 1 }, { unique: true, sparse: true });
pathologyStaffSchema.index({ pathologyId: 1, role: 1, isActive: 1 });
pathologyStaffSchema.index({ pathologyId: 1, phone: 1 });

module.exports = mongoose.model('PathologyStaff', pathologyStaffSchema);
