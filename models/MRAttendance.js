const mongoose = require('mongoose');

const punchSchema = new mongoose.Schema({
  at: Date,
  lat: Number,
  lng: Number,
  accuracy: Number,
}, { _id: false });

const mrAttendanceSchema = new mongoose.Schema({
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'MRProfile', required: true },
  dateKey: { type: String, required: true },
  punchIn: punchSchema,
  punchOut: punchSchema,
  workType: { type: String, enum: ['field', 'office', 'meeting', 'training', 'leave'], default: 'field' },
  status: { type: String, enum: ['present', 'half_day', 'leave', 'absent'], default: 'present' },
  notes: { type: String, trim: true },
}, { timestamps: true });

mrAttendanceSchema.index({ profileId: 1, dateKey: 1 }, { unique: true });
mrAttendanceSchema.index({ dateKey: 1, status: 1 });

module.exports = mongoose.model('MRAttendance', mrAttendanceSchema);
