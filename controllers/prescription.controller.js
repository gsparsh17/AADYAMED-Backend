const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const PatientProfile = require('../models/PatientProfile');

exports.createPrescription = async (req, res) => {
  try {
    const {
      appointmentId,
      diagnosis,
      symptoms,
      medicines,
      labTests,
      advice,
      followUpDate,
      exercises
    } = req.body;
    
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    
    // Check authorization
    if (!canCreatePrescription(req.user, appointment)) {
      return res.status(403).json({ message: 'Not authorized to create prescription' });
    }
    
    // Check if prescription already exists
    const existingPrescription = await Prescription.findOne({ appointmentId });
    if (existingPrescription) {
      return res.status(400).json({ message: 'Prescription already exists for this appointment' });
    }
    
    const prescription = await Prescription.create({
      appointmentId,
      patientId: appointment.patientId,
      [appointment.professionalType === 'doctor' ? 'doctorId' : 'physioId']: 
        appointment.professionalType === 'doctor' ? appointment.doctorId : appointment.physioId,
      professionalType: appointment.professionalType,
      diagnosis,
      symptoms,
      medicines,
      labTests,
      advice,
      followUpDate,
      exercises: appointment.professionalType === 'physiotherapist' ? exercises : undefined,
      status: 'issued'
    });
    
    // Update appointment
    appointment.prescriptionId = prescription._id;
    await appointment.save();
    
    // Generate PDF (in real implementation)
    // prescription.prescriptionPdf = await generatePrescriptionPDF(prescription);
    // await prescription.save();
    
    res.status(201).json({ success: true, prescription });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPrescriptions = async (req, res) => {
  try {
    const { patientId, startDate, endDate, page = 1, limit = 10 } = req.query;
    
    const filter = {};
    
    // Role-based filtering
    if (req.user.role === 'patient') {
      filter.patientId = req.user.profileId;
    } else if (['doctor', 'physiotherapist'].includes(req.user.role)) {
      filter[req.user.role === 'doctor' ? 'doctorId' : 'physioId'] = req.user.profileId;
      filter.professionalType = req.user.role;
    } else if (req.user.role === 'admin') {
      if (patientId) filter.patientId = patientId;
    } else {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    if (startDate && endDate) {
      filter.issuedAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const prescriptions = await Prescription.find(filter)
      .sort({ issuedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('patientId', 'name age gender')
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name specialization')
      .populate('appointmentId', 'appointmentDate type');
    
    const total = await Prescription.countDocuments(filter);
    
    res.json({
      success: true,
      prescriptions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getPrescriptionById = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id)
      .populate('patientId')
      .populate('doctorId')
      .populate('physioId')
      .populate('appointmentId');
    
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    
    // Check authorization
    if (!canViewPrescription(req.user, prescription)) {
      return res.status(403).json({ message: 'Not authorized to view this prescription' });
    }
    
    res.json({ success: true, prescription });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updatePrescription = async (req, res) => {
  try {
    const prescription = await Prescription.findById(req.params.id);
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    
    if (!canUpdatePrescription(req.user, prescription)) {
      return res.status(403).json({ message: 'Not authorized to update this prescription' });
    }
    
    // Create new version
    const newPrescription = prescription.toObject();
    delete newPrescription._id;
    delete newPrescription.prescriptionNumber;
    
    newPrescription.previousVersion = prescription._id;
    newPrescription.version = prescription.version + 1;
    
    // Update with new data
    Object.assign(newPrescription, req.body);
    
    const updatedPrescription = await Prescription.create(newPrescription);
    
    res.json({ success: true, prescription: updatedPrescription });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Authorization helpers
function canCreatePrescription(user, appointment) {
  if (user.role === 'admin') return true;
  
  if (user.role === 'doctor' && 
      appointment.professionalType === 'doctor' &&
      appointment.doctorId?.toString() === user.profileId &&
      appointment.status === 'completed') {
    return true;
  }
  
  if (user.role === 'physiotherapist' &&
      appointment.professionalType === 'physiotherapist' &&
      appointment.physioId?.toString() === user.profileId &&
      appointment.status === 'completed') {
    return true;
  }
  
  return false;
}

function canViewPrescription(user, prescription) {
  if (user.role === 'admin') return true;
  
  if (user.role === 'patient' && 
      prescription.patientId._id.toString() === user.profileId) {
    return true;
  }
  
  if ((user.role === 'doctor' && prescription.doctorId?._id.toString() === user.profileId) ||
      (user.role === 'physiotherapist' && prescription.physioId?._id.toString() === user.profileId)) {
    return true;
  }
  
  return false;
}

function canUpdatePrescription(user, prescription) {
  if (user.role === 'admin') return true;
  
  if ((user.role === 'doctor' && prescription.doctorId?._id.toString() === user.profileId) ||
      (user.role === 'physiotherapist' && prescription.physioId?._id.toString() === user.profileId)) {
    return true;
  }
  
  return false;
}