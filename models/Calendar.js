const mongoose = require('mongoose');

const bookedSlotSchema = new mongoose.Schema({
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
  status: String
});

const breakSlotSchema = new mongoose.Schema({
  startTime: String,
  endTime: String,
  reason: String
});

const professionalDaySchema = new mongoose.Schema({
  professionalId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'professionalType'
  },
  professionalType: {
    type: String,
    enum: ['doctor', 'physiotherapist']
  },
  bookedSlots: [bookedSlotSchema],
  breaks: [breakSlotSchema],
  isAvailable: {
    type: Boolean,
    default: true
  }
});

const calendarDaySchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true
  },
  dayName: String,
  isHoliday: {
    type: Boolean,
    default: false
  },
  holidayReason: String,
  professionals: [professionalDaySchema]
});

const calendarSchema = new mongoose.Schema({
  year: {
    type: Number,
    required: true
  },
  month: {
    type: Number,
    required: true
  },
  days: [calendarDaySchema]
}, {
  timestamps: true
});

calendarSchema.index({ year: 1, month: 1 }, { unique: true });
calendarSchema.index({ 'days.date': 1 });
calendarSchema.index({ 'days.professionals.professionalId': 1 });

module.exports = mongoose.model('Calendar', calendarSchema);