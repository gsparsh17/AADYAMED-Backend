const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const PatientProfile = require('../models/PatientProfile');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const { createNotification } = require('../services/notification.service');
const PharmacyProfile = require('../models/PharmacyProfile');
const EPharmacyOrder = require('../models/EPharmacyOrder');
const { generatePrescriptionPdf } = require('../utils/prescriptionPdf');


async function pharmacyAccessiblePrescriptionIds(user, patientId) {
  if (user.role !== 'pharmacy' || !user.profileId) return [];
  const pharmacy = await PharmacyProfile.findById(user.profileId).select('organizationId defaultStoreId').lean();
  if (!pharmacy) return [];

  const filter = { prescriptionId: { $exists: true, $ne: null } };
  if (patientId) filter.patientId = patientId;
  if (pharmacy.organizationId) filter.organizationId = pharmacy.organizationId;
  else if (pharmacy.defaultStoreId) filter.storeId = pharmacy.defaultStoreId;
  else return [];

  const orders = await EPharmacyOrder.find(filter).select('prescriptionId').lean();
  return [...new Set(orders.map((o) => String(o.prescriptionId)).filter(Boolean))];
}

const EDITABLE_FIELDS = [
  'diagnosis', 'symptoms', 'notes', 'medicines', 'labTests', 'testInstructions',
  'advice', 'patientInstructions', 'followUpDate', 'followUpInstructions',
  'exercises', 'digitalSignature', 'validityDays'
];

function cleanArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizePayload(body = {}) {
  const payload = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  payload.diagnosis = cleanArray(payload.diagnosis).map((item) => String(item).trim()).filter(Boolean);
  payload.symptoms = cleanArray(payload.symptoms).map((item) => String(item).trim()).filter(Boolean);
  if (payload.medicines !== undefined) payload.medicines = cleanArray(payload.medicines);
  if (payload.labTests !== undefined) payload.labTests = cleanArray(payload.labTests);
  if (payload.advice !== undefined) payload.advice = cleanArray(payload.advice);
  if (payload.exercises !== undefined) payload.exercises = cleanArray(payload.exercises);
  return payload;
}

async function professionalProfileForUser(user) {
  if (user.role === 'doctor') {
    return user.profileId
      ? DoctorProfile.findById(user.profileId).select('_id userId name')
      : DoctorProfile.findOne({ userId: user._id || user.id }).select('_id userId name');
  }
  if (user.role === 'physio') {
    return user.profileId
      ? PhysiotherapistProfile.findById(user.profileId).select('_id userId name')
      : PhysiotherapistProfile.findOne({ userId: user._id || user.id }).select('_id userId name');
  }
  return null;
}

async function canOwnAppointment(user, appointment) {
  if (user.role === 'admin') return true;
  if (!['doctor', 'physio'].includes(user.role) || appointment.professionalType !== user.role) return false;
  const profile = await professionalProfileForUser(user);
  if (!profile) return false;
  const assigned = user.role === 'doctor' ? appointment.doctorId : appointment.physioId;
  return String(assigned?._id || assigned) === String(profile._id);
}

async function canViewPrescription(user, prescription) {
  if (user.role === 'admin') return true;
  if (user.role === 'pharmacy') {
    if (!['issued', 'superseded'].includes(prescription.status)) return false;
    const allowedIds = await pharmacyAccessiblePrescriptionIds(user, prescription.patientId?._id || prescription.patientId);
    return allowedIds.includes(String(prescription._id));
  }
  if (user.role === 'patient') {
    const profile = user.profileId
      ? await PatientProfile.findById(user.profileId).select('_id')
      : await PatientProfile.findOne({ userId: user._id || user.id }).select('_id');
    return Boolean(
      profile
      && String(prescription.patientId?._id || prescription.patientId) === String(profile._id)
      && ['issued', 'superseded'].includes(prescription.status)
    );
  }
  if (user.role === 'doctor') {
    const profile = await professionalProfileForUser(user);
    return Boolean(profile && String(prescription.doctorId?._id || prescription.doctorId) === String(profile._id));
  }
  if (user.role === 'physio') {
    const profile = await professionalProfileForUser(user);
    return Boolean(profile && String(prescription.physioId?._id || prescription.physioId) === String(profile._id));
  }
  return false;
}

async function notifyIssued(prescription) {
  try {
    const patient = await PatientProfile.findById(prescription.patientId).select('userId');
    if (!patient?.userId) return;
    await createNotification({
      userId: patient.userId,
      userRole: 'patient',
      title: 'New prescription available',
      message: `Prescription ${prescription.prescriptionNumber} has been issued and is available in your account.`,
      type: 'prescription',
      channels: ['in_app', 'push'],
      relatedEntity: 'Prescription',
      relatedEntityId: prescription._id,
      actionUrl: '/dashboard/patient/prescriptions',
      actionText: 'View prescription'
    });
  } catch (error) {
    console.error('Prescription notification failed:', error.message);
  }
}

function validateForIssue(prescription) {
  if (!Array.isArray(prescription.diagnosis) || prescription.diagnosis.length === 0) {
    const error = new Error('At least one diagnosis is required before issuing a prescription');
    error.statusCode = 400;
    throw error;
  }
}

async function issueDocument(prescription, user) {
  validateForIssue(prescription);
  prescription.status = 'issued';
  prescription.issuedAt = new Date();
  prescription.issuedBy = user._id || user.id;
  prescription.expiresAt = new Date(prescription.issuedAt.getTime() + Number(prescription.validityDays || 30) * 24 * 60 * 60 * 1000);
  await prescription.save();

  if (prescription.previousVersion) {
    await Prescription.updateOne(
      { _id: prescription.previousVersion, status: { $in: ['issued', 'draft'] } },
      { $set: { status: 'superseded' } }
    );
  }
  await Appointment.findByIdAndUpdate(prescription.appointmentId, { prescriptionId: prescription._id });
  await notifyIssued(prescription);
  return prescription;
}

exports.createPrescription = async (req, res) => {
  try {
    const { appointmentId } = req.body;
    if (!appointmentId) return res.status(400).json({ success: false, message: 'appointmentId is required' });

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) return res.status(404).json({ success: false, message: 'Appointment not found' });
    if (!['doctor', 'physio'].includes(appointment.professionalType)) {
      return res.status(400).json({ success: false, message: 'Prescriptions are supported for doctor and physiotherapy appointments only' });
    }
    if (!await canOwnAppointment(req.user, appointment)) {
      return res.status(403).json({ success: false, message: 'Not authorized to prescribe for this appointment' });
    }
    if (!['confirmed', 'accepted', 'in_progress', 'completed'].includes(appointment.status)) {
      return res.status(409).json({ success: false, message: 'Appointment must be confirmed or in progress before prescribing' });
    }

    const current = await Prescription.findOne({ appointmentId, status: { $in: ['draft', 'issued'] } }).sort({ version: -1 });
    if (current) {
      return res.status(409).json({
        success: false,
        message: 'A current prescription already exists for this appointment',
        prescriptionId: current._id,
        status: current.status
      });
    }

    const payload = sanitizePayload(req.body);
    const requestedDraft = req.body.saveAsDraft === true || req.body.status === 'draft';
    const prescription = await Prescription.create({
      ...payload,
      appointmentId,
      patientId: appointment.patientId,
      doctorId: appointment.professionalType === 'doctor' ? appointment.doctorId : undefined,
      physioId: appointment.professionalType === 'physio' ? appointment.physioId : undefined,
      professionalType: appointment.professionalType,
      status: 'draft',
      createdBy: req.user._id || req.user.id
    });

    await Appointment.findByIdAndUpdate(appointmentId, { prescriptionId: prescription._id });
    if (!requestedDraft) await issueDocument(prescription, req.user);

    return res.status(201).json({ success: true, prescription });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.getPrescriptionsByPatientId = async (req, res) => {
  try {
    const { id } = req.params;
    const filter = { patientId: id };
    if (req.user.role === 'patient') {
      if (!req.user.profileId || String(req.user.profileId) !== String(id)) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this patient prescription history' });
      }
      filter.status = { $in: ['issued', 'superseded'] };
    } else if (req.user.role === 'doctor') {
      filter.doctorId = req.user.profileId;
    } else if (req.user.role === 'physio') {
      filter.physioId = req.user.profileId;
    } else if (req.user.role === 'pharmacy') {
      const allowedIds = await pharmacyAccessiblePrescriptionIds(req.user, id);
      filter._id = { $in: allowedIds };
      filter.status = { $in: ['issued', 'superseded'] };
    } else if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    const prescriptions = await Prescription.find(filter)
      .sort({ issuedAt: -1, createdAt: -1 })
      .populate('patientId', 'name age gender phone')
      .populate('doctorId', 'name specialization licenseNumber registrationCouncil')
      .populate('physioId', 'name specialization licenseNumber')
      .populate('appointmentId', 'appointmentDate startTime type status');
    return res.json({ success: true, prescriptions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPrescriptions = async (req, res) => {
  try {
    const { patientId, status, startDate, endDate, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (req.user.role === 'patient') {
      filter.patientId = req.user.profileId;
      filter.status = { $in: ['issued', 'superseded'] };
    } else if (req.user.role === 'doctor') {
      filter.doctorId = req.user.profileId;
    } else if (req.user.role === 'physio') {
      filter.physioId = req.user.profileId;
    } else if (req.user.role === 'pharmacy') {
      const allowedIds = await pharmacyAccessiblePrescriptionIds(req.user, patientId);
      filter._id = { $in: allowedIds };
      filter.status = { $in: ['issued', 'superseded'] };
      if (patientId) filter.patientId = patientId;
    } else if (req.user.role === 'admin') {
      if (patientId) filter.patientId = patientId;
    } else {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (status && req.user.role !== 'patient' && req.user.role !== 'pharmacy') {
      filter.status = { $in: String(status).split(',').map((item) => item.trim()).filter(Boolean) };
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const safeLimit = Math.min(100, Math.max(1, Number(limit)));
    const safePage = Math.max(1, Number(page));
    const prescriptions = await Prescription.find(filter)
      .sort({ issuedAt: -1, createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('patientId', 'name age gender phone')
      .populate('doctorId', 'name specialization licenseNumber registrationCouncil')
      .populate('physioId', 'name specialization licenseNumber')
      .populate('appointmentId', 'appointmentDate startTime type status');
    const total = await Prescription.countDocuments(filter);

    return res.json({
      success: true,
      prescriptions,
      pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getByAppointment = async (req, res) => {
  try {
    const filter = { appointmentId: req.params.appointmentId };
    if (req.user.role === 'patient' || req.user.role === 'pharmacy') {
      filter.status = { $in: ['issued', 'superseded'] };
    }
    const prescriptions = await Prescription.find(filter)
      .sort({ version: -1 })
      .populate('patientId', 'name age gender phone')
      .populate('doctorId', 'name specialization licenseNumber registrationCouncil')
      .populate('physioId', 'name specialization licenseNumber');
    if (!prescriptions.length) return res.status(404).json({ success: false, message: 'Prescription not found for this appointment' });
    if (!await canViewPrescription(req.user, prescriptions[0])) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this prescription' });
    }
    return res.json({ success: true, prescription: prescriptions[0], versions: prescriptions });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patientId', 'name age gender phone email address')
      .populate('doctorId', 'name specialization licenseNumber registrationCouncil clinicName')
      .populate('physioId', 'name specialization licenseNumber')
      .populate('appointmentId', 'appointmentDate startTime type status');
    if (!prescription) return res.status(404).json({ success: false, message: 'Prescription not found' });
    if (!await canViewPrescription(req.user, prescription)) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this prescription' });
    }
    return res.json({ success: true, prescription });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id);
    if (!prescription) return res.status(404).json({ success: false, message: 'Prescription not found' });
    const appointment = await Appointment.findById(prescription.appointmentId);
    if (!appointment || !await canOwnAppointment(req.user, appointment)) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this prescription' });
    }
    if (['cancelled', 'superseded'].includes(prescription.status)) {
      return res.status(409).json({ success: false, message: `Cannot edit a ${prescription.status} prescription` });
    }

    const payload = sanitizePayload(req.body);
    if (prescription.status === 'draft') {
      Object.assign(prescription, payload);
      await prescription.save();
      return res.json({ success: true, prescription });
    }

    const source = prescription.toObject();
    for (const key of ['_id', 'createdAt', 'updatedAt', 'issuedAt', 'issuedBy', 'expiresAt', 'prescriptionNumber', 'status', '__v']) delete source[key];
    const revision = await Prescription.create({
      ...source,
      ...payload,
      status: 'draft',
      version: Number(prescription.version || 1) + 1,
      previousVersion: prescription._id,
      createdBy: req.user._id || req.user.id,
      pharmacyStatus: 'not_dispensed',
      dispensedItems: []
    });
    return res.status(201).json({ success: true, prescription: revision, revisionCreated: true });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.issuePrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id);
    if (!prescription) return res.status(404).json({ success: false, message: 'Prescription not found' });
    if (prescription.status !== 'draft') {
      return res.status(409).json({ success: false, message: 'Only draft prescriptions can be issued' });
    }
    const appointment = await Appointment.findById(prescription.appointmentId);
    if (!appointment || !await canOwnAppointment(req.user, appointment)) {
      return res.status(403).json({ success: false, message: 'Not authorized to issue this prescription' });
    }
    await issueDocument(prescription, req.user);
    return res.json({ success: true, prescription });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.cancelPrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id);
    if (!prescription) return res.status(404).json({ success: false, message: 'Prescription not found' });
    const appointment = await Appointment.findById(prescription.appointmentId);
    if (!appointment || !await canOwnAppointment(req.user, appointment)) {
      return res.status(403).json({ success: false, message: 'Not authorized to cancel this prescription' });
    }
    if (prescription.pharmacyStatus === 'fully_dispensed') {
      return res.status(409).json({ success: false, message: 'A fully dispensed prescription cannot be cancelled' });
    }
    prescription.status = 'cancelled';
    prescription.cancelledAt = new Date();
    prescription.cancelledBy = req.user._id || req.user.id;
    prescription.cancellationReason = String(req.body.reason || 'Cancelled by prescriber');
    prescription.pharmacyStatus = 'cancelled';
    await prescription.save();
    return res.json({ success: true, prescription });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.downloadPdf = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patientId', 'name age gender phone')
      .populate('doctorId', 'name specialization licenseNumber registrationCouncil clinicName')
      .populate('physioId', 'name specialization licenseNumber');
    if (!prescription) return res.status(404).json({ success: false, message: 'Prescription not found' });
    if (!await canViewPrescription(req.user, prescription)) {
      return res.status(403).json({ success: false, message: 'Not authorized to download this prescription' });
    }
    if (req.user.role === 'patient' && prescription.status !== 'issued' && prescription.status !== 'superseded') {
      return res.status(403).json({ success: false, message: 'Draft prescriptions are not available to patients' });
    }

    const pdf = await generatePrescriptionPdf(prescription);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${prescription.prescriptionNumber || 'prescription'}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(pdf);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
