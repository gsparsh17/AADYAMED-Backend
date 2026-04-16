const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientProfile',
      required: true,
    },
    professionalId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      // This will reference DoctorProfile, PhysiotherapistProfile, PathologyProfile, or PharmacyProfile
    },
    professionalType: {
      type: String,
      enum: ['doctor', 'physio', 'pathology', 'pharmacy'],
      required: true,
    },
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment', // Optional, link chat to an appointment if needed
    },
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatMessage',
    },
    status: {
      type: String,
      enum: ['active', 'closed'],
      default: 'active',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ChatSession', chatSessionSchema);
