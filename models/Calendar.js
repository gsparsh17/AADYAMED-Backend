const mongoose = require('mongoose');

const CalendarSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true,
    index: true
  },
  month: {
    type: Number,
    required: true,
    min: 1,
    max: 12,
    index: true
  },
  days: [{
    date: {
      type: Date,
      required: true,
      index: true
    },
    dayName: {
      type: String,
      enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    },
    isHoliday: {
      type: Boolean,
      default: false
    },
    professionals: [{
      professionalId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        refPath: 'days.professionals.professionalType'
      },
      professionalType: {
        type: String,
        required: true,
        enum: ['doctor', 'physiotherapist', 'pathology']
      },
      bookedSlots: [{
        appointmentId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Appointment'
        },
        patientId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'PatientProfile'
        },
        startTime: String,
        endTime: String,
        bookedAt: Date,
        bookedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        status: {
          type: String,
          default: 'booked'
        }
      }],
      breaks: [{
        startTime: String,
        endTime: String,
        reason: String,
        addedAt: Date,
        addedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        }
      }],
      workingHours: [{
        startTime: String,
        endTime: String
      }],
      isAvailable: {
        type: Boolean,
        default: true
      }
    }]
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for fast month-based queries
CalendarSchema.index({ year: 1, month: 1 }, { unique: true });

// Index for professional lookups
CalendarSchema.index({ 
  'days.professionals.professionalId': 1,
  'days.professionals.professionalType': 1 
});

// Index for date-based queries
CalendarSchema.index({ 'days.date': 1 });

// Pre-save middleware to update timestamps
CalendarSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Method to get day by date
CalendarSchema.methods.getDayByDate = function(date) {
  const dateStr = new Date(date).toISOString().split('T')[0];
  return this.days.find(day => {
    const dayDate = new Date(day.date);
    return dayDate.toISOString().split('T')[0] === dateStr;
  });
};

// Method to add professional to a day
CalendarSchema.methods.addProfessionalToDay = function(date, professionalData) {
  const day = this.getDayByDate(date);
  if (day) {
    const exists = day.professionals.some(p => 
      p.professionalId.toString() === professionalData.professionalId.toString() &&
      p.professionalType === professionalData.professionalType
    );
    if (!exists) {
      day.professionals.push(professionalData);
      return true;
    }
  }
  return false;
};

// Method to book slot
CalendarSchema.methods.bookSlot = function(date, professionalId, professionalType, slotData) {
  const day = this.getDayByDate(date);
  if (day) {
    const professional = day.professionals.find(p => 
      p.professionalId.toString() === professionalId.toString() &&
      p.professionalType === professionalType
    );
    if (professional && professional.isAvailable) {
      // Check if slot is already booked
      const isBooked = professional.bookedSlots.some(slot => 
        slot.startTime === slotData.startTime && slot.endTime === slotData.endTime
      );
      if (!isBooked) {
        professional.bookedSlots.push(slotData);
        return true;
      }
    }
  }
  return false;
};

module.exports = mongoose.model('Calendar', CalendarSchema);