const mongoose = require('mongoose');

const professionalResponseSchema = new mongoose.Schema(
  {
    response: String,
    respondedAt: Date,
    isPublic: { type: Boolean, default: true }
  },
  { _id: false }
);

const feedbackSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
      required: true,
      unique: true
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientProfile',
      required: true
    },
    professionalId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      // Dynamic ref — professionalType is only ever 'doctor'/'physio', so a
      // virtual maps it to the actual model name refPath needs.
      refPath: 'professionalModel'
    },
    professionalType: {
      type: String,
      enum: ['doctor', 'physio'],
      required: true
    },

    overallRating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    categoryRatings: {
      type: Map,
      of: Number,
      default: undefined
    },
    comments: String,
    strengths: [String],
    areasForImprovement: [String],
    wouldRecommend: Boolean,
    isAnonymous: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['submitted', 'approved', 'rejected'],
      default: 'submitted'
    },
    adminNotes: String,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,

    professionalResponse: professionalResponseSchema
  },
  { timestamps: true }
);

feedbackSchema.virtual('professionalModel').get(function () {
  return this.professionalType === 'physio' ? 'PhysiotherapistProfile' : 'DoctorProfile';
});

feedbackSchema.index({ professionalId: 1, professionalType: 1, status: 1 });
feedbackSchema.index({ patientId: 1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
