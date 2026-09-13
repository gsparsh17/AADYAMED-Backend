const PatientProfile = require('../models/PatientProfile');

function normalizePatient(patient) {
  const obj = typeof patient.toObject === 'function' ? patient.toObject() : { ...patient };
  return {
    _id: obj._id,
    patientId: obj.patientId,
    patient_id: obj.patientId,
    name: obj.name,
    firstName: obj.firstName,
    first_name: obj.firstName,
    lastName: obj.lastName,
    last_name: obj.lastName,
    phone: obj.phone,
    email: obj.email,
    gender: obj.gender,
    dateOfBirth: obj.dateOfBirth,
    address: obj.address,
  };
}

exports.listPatients = async (req, res) => {
  try {
    const query = String(req.query.query || req.query.search || '').trim();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};

    if (query) {
      const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { firstName: { $regex: safe, $options: 'i' } },
        { lastName: { $regex: safe, $options: 'i' } },
        { phone: { $regex: safe, $options: 'i' } },
        { patientId: { $regex: safe, $options: 'i' } },
      ];
    }

    const patients = await PatientProfile.find(filter)
      .select('patientId name firstName lastName phone email gender dateOfBirth address')
      .sort({ name: 1 })
      .limit(limit);

    res.json({ success: true, patients: patients.map(normalizePatient) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
