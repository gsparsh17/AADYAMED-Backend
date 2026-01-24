const PatientProfile = require('../models/PatientProfile');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const LabTest = require('../models/LabTest');
const Invoice = require('../models/Invoice');

exports.getProfile = async (req, res) => {
  try {
    const profile = await PatientProfile.findOne({ 
      userId: req.user.id 
    }).populate('userId', 'email isVerified');
    
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    
    const profile = await PatientProfile.findOneAndUpdate(
      { userId: req.user.id },
      updates,
      { new: true, runValidators: true }
    );
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getMedicalHistory = async (req, res) => {
  try {
    const profile = await PatientProfile.findById(req.user.profileId)
      .select('medicalHistory allergies currentMedications chronicConditions');
    
    res.json({ success: true, medicalHistory: profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addMedicalRecord = async (req, res) => {
  try {
    const { 
      recordType, // 'medicalHistory', 'allergy', 'medication', 'condition'
      data 
    } = req.body;
    
    const profile = await PatientProfile.findById(req.user.profileId);
    
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    
    switch(recordType) {
      case 'medicalHistory':
        profile.medicalHistory.push(data);
        break;
      case 'allergy':
        profile.allergies.push(data);
        break;
      case 'medication':
        profile.currentMedications.push(data);
        break;
      case 'condition':
        profile.chronicConditions.push(data);
        break;
      default:
        return res.status(400).json({ message: 'Invalid record type' });
    }
    
    await profile.save();
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAppointments = async (req, res) => {
  try {
    const { 
      status, 
      type,
      page = 1,
      limit = 20 
    } = req.query;
    
    const filter = { 
      patientId: req.user.profileId
    };
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    
    const appointments = await Appointment.find(filter)
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name specialization')
      .sort({ appointmentDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Appointment.countDocuments(filter);
    
    // Get upcoming appointments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const upcomingAppointments = await Appointment.countDocuments({
      patientId: req.user.profileId,
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted'] }
    });
    
    res.json({
      success: true,
      appointments,
      upcomingAppointments,
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

exports.getPrescriptions = async (req, res) => {
  try {
    const { 
      page = 1,
      limit = 20 
    } = req.query;
    
    const prescriptions = await Prescription.find({ 
      patientId: req.user.profileId 
    })
    .populate('doctorId', 'name specialization')
    .populate('physioId', 'name specialization')
    .populate('appointmentId', 'appointmentDate')
    .sort({ issuedAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));
    
    const total = await Prescription.countDocuments({ patientId: req.user.profileId });
    
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

exports.getLabReports = async (req, res) => {
  try {
    const { 
      page = 1,
      limit = 20 
    } = req.query;
    
    const labTests = await LabTest.find({ 
      patientId: req.user.profileId,
      status: 'completed'
    })
    .populate('pathologyId', 'labName')
    .populate('doctorId', 'name')
    .sort({ reportGeneratedAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));
    
    const total = await LabTest.countDocuments({ 
      patientId: req.user.profileId,
      status: 'completed'
    });
    
    res.json({
      success: true,
      labTests,
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

exports.getInvoices = async (req, res) => {
  try {
    const { 
      status,
      type,
      page = 1,
      limit = 20 
    } = req.query;
    
    const filter = { 
      patientId: req.user.profileId
    };
    
    if (status) filter.status = status;
    if (type) filter.invoiceType = type;
    
    const invoices = await Invoice.find(filter)
      .sort({ invoiceDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Invoice.countDocuments(filter);
    
    // Get outstanding balance
    const outstanding = await Invoice.aggregate([
      {
        $match: {
          patientId: req.user.profileId,
          status: { $in: ['sent', 'partial', 'overdue'] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$balanceDue' }
        }
      }
    ]);
    
    res.json({
      success: true,
      invoices,
      outstandingBalance: outstanding[0]?.total || 0,
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

exports.getDashboardStats = async (req, res) => {
  try {
    const profile = await PatientProfile.findById(req.user.profileId);
    
    const appointments = await Appointment.countDocuments({ 
      patientId: req.user.profileId 
    });
    
    const prescriptions = await Prescription.countDocuments({ 
      patientId: req.user.profileId 
    });
    
    const labTests = await LabTest.countDocuments({ 
      patientId: req.user.profileId 
    });
    
    const invoices = await Invoice.aggregate([
      {
        $match: { patientId: req.user.profileId }
      },
      {
        $group: {
          _id: null,
          totalSpent: { $sum: '$totalAmount' },
          pendingPayment: { 
            $sum: { 
              $cond: [{ $in: ['$status', ['sent', 'partial', 'overdue']] }, '$balanceDue', 0] 
            }
          }
        }
      }
    ]);
    
    // Get upcoming appointments
    const today = new Date();
    const upcomingAppointments = await Appointment.find({
      patientId: req.user.profileId,
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted'] }
    })
    .populate('doctorId', 'name specialization')
    .populate('physioId', 'name specialization')
    .sort({ appointmentDate: 1 })
    .limit(5);
    
    res.json({
      success: true,
      stats: {
        totalAppointments: appointments,
        totalPrescriptions: prescriptions,
        totalLabTests: labTests,
        totalSpent: invoices[0]?.totalSpent || 0,
        pendingPayment: invoices[0]?.pendingPayment || 0
      },
      upcomingAppointments,
      profile: {
        name: profile.name,
        age: profile.age,
        bloodGroup: profile.bloodGroup,
        lastConsultation: profile.lastConsultation
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};