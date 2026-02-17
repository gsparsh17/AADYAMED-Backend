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

    professionalType: {
      type: String,
      enum: ['doctor', 'physio'],
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
      enum: ['clinic', 'home'],
      required: true,
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
          return this.type === 'home';
        },
      },
      coordinates: {
        type: [Number],
        required: function () {
          return this.type === 'home';
        },
        validate: {
          validator: function (v) {
            // If not home visit, allow empty
            if (this.type !== 'home') return true;

            // Must be [lng, lat]
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

    // Symptoms & Reason
    symptoms: [String],
    reason: String,
    notes: String,

    // Status
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

    // Rescheduling/Cancellation
    cancellationReason: String,

    cancelledBy: {
      type: String,
      enum: ['patient', 'professional', 'admin', 'system'],
    },

    cancellationFee: {
      type: Number,
      default: 0,
      min: 0,
    },

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
      },
    ],

    // Follow-up
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

    // Consultation
    actualStartTime: Date,
    actualEndTime: Date,
    consultationNotes: String,

    prescriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Prescription',
    },

    // Notifications
    remindersSent: [
      {
        type: String,
        enum: ['24h_before', '2h_before', '15min_before'],
        sentAt: Date,
      },
    ],

    // Metadata
    bookedBy: {
      type: String,
      enum: ['patient', 'admin', 'assistant'],
      default: 'patient',
    },

    deviceInfo: String,
    ipAddress: String,
  },
  { timestamps: true }
);

/**
 * ✅ Indexes
 * - Removed professionalId index (field doesn't exist in your schema)
 * - Added doctorId/physioId indexes
 * - 2dsphere index is partial: only docs with valid geo are indexed
 */
appointmentSchema.index({ patientId: 1, status: 1 });
appointmentSchema.index({ doctorId: 1, status: 1 });
appointmentSchema.index({ physioId: 1, status: 1 });
appointmentSchema.index({ appointmentDate: 1, startTime: 1 });
appointmentSchema.index({ status: 1, paymentStatus: 1 });

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

/**
 * ✅ Safety hook:
 * If NOT home visit, ensure we do NOT store a half-baked location
 * (prevents "type: Point" without coordinates issues)
 */
appointmentSchema.pre('validate', function (next) {
  if (this.type !== 'home') {
    this.address = undefined;
    this.location = undefined;
  }
  next();
});

// Calculate professional earning before save
appointmentSchema.pre('save', function (next) {
  if (this.isModified('consultationFee') || this.isModified('platformCommission') || this.isModified('homeVisitCharges')) {
    this.professionalEarning = (this.consultationFee || 0) - (this.platformCommission || 0);
    this.totalAmount = (this.consultationFee || 0) + (this.homeVisitCharges || 0);
  }
  next();
});

module.exports = mongoose.model('Appointment', appointmentSchema);
