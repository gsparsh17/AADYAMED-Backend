const mongoose = require('mongoose');

const labReportSchema = new mongoose.Schema({
  // Was 'Patient'/'Doctor' — those models don't exist in this codebase
  // (the real ones are PatientProfile/DoctorProfile), so .populate() here
  // would throw "Schema hasn't been registered for model" on every call.
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorProfile' },
  report_type: { type: String, required: true },
  file_url: { type: String }, // URL to uploaded file
  report_date: { type: Date, required: true },
  notes: { type: String }
});

module.exports = mongoose.model('LabReport', labReportSchema);
