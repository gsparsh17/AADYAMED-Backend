const mongoose = require('mongoose');

// A leave request. Dates are app-timezone day keys (YYYY-MM-DD), inclusive.
// Approving it marks those days as leave in MRAttendance.
const mrLeaveSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  toDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  days: { type: Number, min: 0.5, required: true },
  halfDay: { type: Boolean, default: false },
  leaveType: { type: String, enum: ['casual', 'sick', 'earned', 'other'], default: 'casual' },
  reason: { type: String, trim: true, maxlength: 500 },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', default: null },
  reviewedAt: Date,
  managerComment: String,
}, { timestamps: true });

mrLeaveSchema.index({ profileId: 1, fromDate: -1 });
mrLeaveSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('MRLeave', mrLeaveSchema);
