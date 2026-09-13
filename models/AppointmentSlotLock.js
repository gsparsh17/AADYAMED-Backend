const mongoose = require('mongoose');

const appointmentSlotLockSchema = new mongoose.Schema({
  professionalType: {
    type: String,
    enum: ['doctor', 'physio', 'pathology'],
    required: true,
  },
  professionalId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  appointmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Appointment',
    // Normal non-unique index; do not request sparse=true because existing
    // Patch-3 databases may already have appointmentId_1 without sparse.
    index: true,
  },
  dateKey: {
    type: String,
    required: true,
    match: /^\d{4}-\d{2}-\d{2}$/,
  },
  startTime: {
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):([0-5]\d)$/,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });

appointmentSlotLockSchema.index(
  { professionalType: 1, professionalId: 1, dateKey: 1, startTime: 1 },
  { unique: true, name: 'unique_professional_slot_lock' }
);
module.exports = mongoose.model('AppointmentSlotLock', appointmentSlotLockSchema);
