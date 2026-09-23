const LabReport = require('../models/LabReport');

// Scope every query to who's asking — this endpoint has no organization/store
// concept like pharmacy does, so "scoping" here just means a doctor only ever
// sees reports they authored and a patient only ever sees their own.
function scopedFilter(req, extra = {}) {
  if (req.user.role === 'admin') return extra;
  if (req.user.role === 'doctor') return { ...extra, doctor_id: req.user.profileId };
  if (req.user.role === 'patient') return { ...extra, patient_id: req.user.profileId };
  const error = new Error('Not authorized to access lab reports');
  error.statusCode = 403;
  throw error;
}

exports.createLabReport = async (req, res) => {
  try {
    if (req.user.role !== 'doctor' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only doctors can create lab reports' });
    }
    const payload = { ...req.body };
    // A doctor can only ever author a report as themselves, never on behalf
    // of another doctor's profileId.
    if (req.user.role === 'doctor') payload.doctor_id = req.user.profileId;

    const report = new LabReport(payload);
    await report.save();
    res.status(201).json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllLabReports = async (req, res) => {
  try {
    const reports = await LabReport.find(scopedFilter(req))
      .populate('patient_id', 'name phone')
      .populate('doctor_id', 'name specialization');
    res.json(reports);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.getReportById = async (req, res) => {
  try {
    const report = await LabReport.findOne(scopedFilter(req, { _id: req.params.id }))
      .populate('patient_id', 'name phone')
      .populate('doctor_id', 'name specialization');
    if (!report) return res.status(404).json({ error: 'Lab report not found' });
    res.json(report);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

exports.deleteReport = async (req, res) => {
  try {
    const report = await LabReport.findOneAndDelete(scopedFilter(req, { _id: req.params.id }));
    if (!report) return res.status(404).json({ error: 'Lab report not found' });
    res.json({ message: 'Lab report deleted successfully' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};
