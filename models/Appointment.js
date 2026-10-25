const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema(
  {
    referralId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Referral',
    },

    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientProfile',
      required: true,
    },

    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DoctorProfile',
    },

    physioId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PhysiotherapistProfile',
    },

    // Optional physiotherapy treatment course (package) this session belongs to.
    treatmentCourseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PhysioTreatmentCourse',
    },

    // ✅ NEW
    pathologyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PathologyProfile',
    },

    // ✅ UPDATED
    professionalType: {
      type: String,
      enum: ['doctor', 'physio', 'pathology'],
      required: true,
    },

    // Appointment Details
    appointmentDate: {
      type: Date,
      required: true,
    },

    startTime: {
      type: String,
      required: true,
      match: /^([01]\d|2[0-3]):([0-5]\d)$/, // HH:MM
    },

    endTime: {
      type: String,
      match: /^([01]\d|2[0-3]):([0-5]\d)$/, // HH:MM
    },

    duration: {
      type: Number,
      default: 30,
      min: 5,
    },

    type: {
      type: String,
      enum: ['clinic', 'home', 'video'],
      required: true,
    },

    // Legacy video meeting URL. Hidden from ordinary queries; Patch 4 serves
    // join URLs only through the authorized consultation session endpoint.
    meetingLink: {
      type: String,
      select: false,
    },
    videoProvider: {
      type: String,
      enum: ['jitsi', 'external'],
      default: 'jitsi',
    },
    consultationSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConsultationSession',
    },

    // Location
    address: {
      type: String,
      required: function () {
        return this.type === 'home';
      },
    },

    /**
     * IMPORTANT:
     * - NO default "Point"
     * - Required ONLY for home appointments
     * - Validates that coordinates exist and are [lng, lat]
     */
    location: {
      type: {
        type: String,
        enum: ['Point'],
        required: function () {
          // Pathology home collection can be booked with a postal address even
          // when browser GPS coordinates are unavailable. Doctor/physio home
          // visits continue to require coordinates.
          return this.type === 'home' && this.professionalType !== 'pathology';
        },
      },
      coordinates: {
        type: [Number],
        required: function () {
          return this.type === 'home' && this.professionalType !== 'pathology';
        },
        validate: {
          validator: function (v) {
            if (this.type !== 'home' || this.professionalType === 'pathology') return true;

            return (
              Array.isArray(v) &&
              v.length === 2 &&
              typeof v[0] === 'number' &&
              typeof v[1] === 'number' &&
              !Number.isNaN(v[0]) &&
              !Number.isNaN(v[1]) &&
              v[0] >= -180 &&
              v[0] <= 180 &&
              v[1] >= -90 &&
              v[1] <= 90
            );
          },
          message: 'location.coordinates must be [lng, lat] with valid ranges',
        },
      },
    },

    symptoms: [String],
    reason: String,
    notes: String,

    status: {
      type: String,
      enum: [
        'pending',
        'confirmed',
        'accepted',
        'rejected',
        'rescheduled',
        'cancelled',
        'completed',
        'no_show',
        'in_progress',
      ],
      default: 'pending',
    },

    // Payment
    consultationFee: {
      type: Number,
      required: true,
      min: 0,
    },

    homeVisitCharges: {
      type: Number,
      default: 0,
      min: 0,
    },

    platformCommission: {
      type: Number,
      required: true,
      min: 0,
    },

    professionalEarning: {
      type: Number,
      required: true,
      min: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded', 'partially_refunded'],
      default: 'pending',
    },

    paymentId: String,
    razorpayOrderId: String,
    razorpayPaymentId: String,
    paymentDate: Date,

    cancellationReason: String,
    cancelledAt: Date,

    cancelledBy: {
      type: String,
      enum: ['patient', 'professional', 'admin', 'system'],
    },

    cancellationFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Set when the professional marks the appointment 'no_show' (after the
    // start time). No refund is issued for a no-show.
    noShowAt: Date,
    noShowReason: String,
    noShowMarkedBy: String,

    rescheduleCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    previousAppointments: [
      {
        appointmentId: mongoose.Schema.Types.ObjectId,
        date: Date,
        reason: String,
        originalDate: Date,
        originalTime: String,
        rescheduledDate: Date,
      },
    ],

    rescheduleReason: String,

    followUpDate: Date,
    followUpNotes: String,

    isFollowUp: {
      type: Boolean,
      default: false,
    },

    originalAppointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Appointment',
    },

    respondedBy: String,
    respondedAt: Date,

    actualStartTime: Date,
    actualEndTime: Date,
    consultationNotes: String,
    professionalNotes: String,
    patientNotes: String,
    followupRequired: { type: Boolean, default: false },

    prescriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Prescription',
    },

    remindersSent: [
      {
        type: String,
        enum: ['24h_before', '2h_before', '15min_before'],
        sentAt: Date,
      },
    ],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    bookedBy: {
      type: String,
      enum: ['patient', 'admin', 'assistant', 'doctor', 'physio'],
      default: 'patient',
    },

    deviceInfo: String,
    ipAddress: String,
  },
  { timestamps: true }
);

// ✅ Indexes
appointmentSchema.index({ patientId: 1, status: 1 });
appointmentSchema.index({ doctorId: 1, status: 1 });
appointmentSchema.index({ physioId: 1, status: 1 });
appointmentSchema.index({ physioId: 1, appointmentDate: 1 });
appointmentSchema.index({ treatmentCourseId: 1 }, { sparse: true });
// ✅ NEW
appointmentSchema.index({ pathologyId: 1, status: 1 });

appointmentSchema.index({ appointmentDate: 1, startTime: 1 });
appointmentSchema.index({ doctorId: 1, appointmentDate: 1, startTime: 1 });
appointmentSchema.index({ patientId: 1, appointmentDate: -1 });
appointmentSchema.index({ status: 1, paymentStatus: 1 });
appointmentSchema.index({ consultationSessionId: 1 });

appointmentSchema.index(
  { location: '2dsphere' },
  {
    partialFilterExpression: {
      'location.type': 'Point',
      'location.coordinates.0': { $exists: true },
      'location.coordinates.1': { $exists: true },
    },
  }
);

appointmentSchema.pre('validate', function (next) {
  if (this.type !== 'home') {
    this.address = undefined;
    this.location = undefined;
  }
  next();
});

appointmentSchema.pre('save', function (next) {
  if (
    this.isModified('consultationFee') ||
    this.isModified('platformCommission') ||
    this.isModified('homeVisitCharges')
  ) {
    this.professionalEarning = (this.consultationFee || 0) - (this.platformCommission || 0);
    this.totalAmount = (this.consultationFee || 0) + (this.homeVisitCharges || 0);
  }
  next();
});

module.exports = mongoose.model('Appointment', appointmentSchema);
