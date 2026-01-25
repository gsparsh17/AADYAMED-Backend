const PatientProfile = require('../models/PatientProfile');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const LabTest = require('../models/LabTest');
const Invoice = require('../models/Invoice');

// ========== PATIENT-ONLY FUNCTIONS ==========

// Get current patient's profile
exports.getProfile = async (req, res) => {
  try {
    const profile = await PatientProfile.findOne({ 
      userId: req.user.id 
    }).populate('userId', 'email isVerified lastLogin');
    
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found. Please complete your profile.'
      });
    }
    
    // Set profileId in user object for other functions
    req.user.profileId = profile._id;
    
    res.json({
      success: true,
      profile: {
        id: profile._id,
        patientId: profile.patientId,
        name: profile.name,
        firstName: profile.firstName,
        middleName: profile.middleName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        gender: profile.gender,
        dateOfBirth: profile.dateOfBirth,
        age: profile.age,
        bloodGroup: profile.bloodGroup,
        height: profile.height,
        weight: profile.weight,
        bmi: profile.bmi,
        address: profile.address,
        emergencyContact: profile.emergencyContact,
        insuranceProvider: profile.insuranceProvider,
        aadhaarNumber: profile.aadhaarNumber,
        preferences: profile.preferences,
        profileImage: profile.profileImage,
        registeredAt: profile.registeredAt
      }
    });
  } catch (error) {
    console.error('Error fetching patient profile:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
};

// Update current patient's profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    
    // Get profile first
    let profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      // Create profile if it doesn't exist
      profile = new PatientProfile({
        userId: req.user.id,
        ...updates
      });
    } else {
      // Remove fields that shouldn't be updated directly
      delete updates.patientId;
      delete updates.totalAppointments;
      delete updates.totalPrescriptions;
      delete updates.totalLabTests;
      delete updates.userId;
      delete updates.registeredAt;
      
      // Update profile
      Object.assign(profile, updates);
    }
    
    // Set name from firstName and lastName
    if (updates.firstName || updates.lastName) {
      const firstName = updates.firstName || profile.firstName;
      const lastName = updates.lastName || profile.lastName;
      if (firstName && lastName) {
        profile.name = `${firstName} ${lastName}`.trim();
      }
    }
    
    await profile.save();
    
    // Update user email if changed
    if (updates.email && profile.userId) {
      const User = require('../models/User');
      await User.findByIdAndUpdate(profile.userId, {
        email: updates.email,
        phone: updates.phone || profile.phone
      });
    }
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      profile: {
        id: profile._id,
        patientId: profile.patientId,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        dateOfBirth: profile.dateOfBirth,
        age: profile.age,
        bloodGroup: profile.bloodGroup
      }
    });
  } catch (error) {
    console.error('Error updating patient profile:', error.message);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach(key => {
        errors[key] = error.errors[key].message;
      });
      
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        errors
      });
    }
    
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// Get medical history
exports.getMedicalHistory = async (req, res) => {
  try {
    // Get profile ID
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    res.json({
      success: true,
      medicalHistory: {
        conditions: profile.medicalHistory || [],
        allergies: profile.allergies || [],
        currentMedications: profile.currentMedications || [],
        chronicConditions: profile.chronicConditions || []
      },
      summary: {
        totalConditions: profile.medicalHistory?.length || 0,
        totalAllergies: profile.allergies?.length || 0,
        totalMedications: profile.currentMedications?.length || 0,
        totalChronicConditions: profile.chronicConditions?.length || 0
      }
    });
  } catch (error) {
    console.error('Error fetching medical history:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch medical history'
    });
  }
};

// Add medical record
exports.addMedicalRecord = async (req, res) => {
  try {
    const { 
      recordType, // 'medicalHistory', 'allergy', 'medication', 'condition'
      data 
    } = req.body;
    
    if (!recordType || !data) {
      return res.status(400).json({
        success: false,
        error: 'Record type and data are required'
      });
    }
    
    // Get profile
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const recordData = {
      ...data,
      addedBy: req.user.id,
      addedAt: new Date()
    };
    
    let updatedProfile;
    switch(recordType) {
      case 'medicalHistory':
        profile.medicalHistory = profile.medicalHistory || [];
        profile.medicalHistory.push(recordData);
        updatedProfile = await profile.save();
        break;
        
      case 'allergy':
        profile.allergies = profile.allergies || [];
        profile.allergies.push(recordData);
        updatedProfile = await profile.save();
        break;
        
      case 'medication':
        profile.currentMedications = profile.currentMedications || [];
        profile.currentMedications.push(recordData);
        updatedProfile = await profile.save();
        break;
        
      case 'condition':
        profile.chronicConditions = profile.chronicConditions || [];
        profile.chronicConditions.push(recordData);
        updatedProfile = await profile.save();
        break;
        
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid record type. Must be: medicalHistory, allergy, medication, or condition'
        });
    }
    
    res.json({
      success: true,
      message: 'Medical record added successfully',
      recordType,
      record: recordData
    });
  } catch (error) {
    console.error('Error adding medical record:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// Get appointments
exports.getAppointments = async (req, res) => {
  try {
    const { 
      status, 
      type,
      professionalType,
      startDate,
      endDate,
      page = 1,
      limit = 20 
    } = req.query;
    
    // Get profile ID
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const filter = { 
      patientId: profile._id
    };
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (professionalType) filter.professionalType = professionalType;
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      filter.appointmentDate = {
        $gte: start,
        $lte: end
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const appointments = await Appointment.find(filter)
      .populate('doctorId', 'name specialization consultationFee clinicAddress')
      .populate('physioId', 'name services consultationFee clinicAddress')
      .populate('referralId', 'requirement symptoms')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Appointment.countDocuments(filter);
    
    // Get upcoming appointments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const upcomingAppointments = await Appointment.find({
      patientId: profile._id,
      appointmentDate: { $gte: today },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    })
    .populate('doctorId', 'name specialization')
    .populate('physioId', 'name services')
    .sort({ appointmentDate: 1 })
    .limit(5);
    
    // Get appointment statistics
    const stats = await Appointment.aggregate([
      { $match: { patientId: profile._id } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      appointments,
      upcomingAppointments,
      stats: stats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {}),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching appointments:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointments'
    });
  }
};

// Get prescriptions
exports.getPrescriptions = async (req, res) => {
  try {
    const { 
      status,
      recent = false,
      page = 1,
      limit = 20 
    } = req.query;
    
    // Get profile ID
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const filter = { 
      patientId: profile._id
    };
    
    if (status) filter.pharmacyStatus = status;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    let query = Prescription.find(filter)
      .populate('doctorId', 'name specialization clinicAddress')
      .populate('physioId', 'name services clinicAddress')
      .populate('appointmentId', 'appointmentDate type')
      .sort({ issuedAt: -1 })
      .skip(skip);
    
    if (!recent) {
      query = query.limit(parseInt(limit));
    } else {
      query = query.limit(5);
    }
    
    const prescriptions = await query;
    
    const total = await Prescription.countDocuments(filter);
    
    // Get active prescriptions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const activePrescriptions = await Prescription.countDocuments({
      patientId: profile._id,
      issuedAt: { $gte: thirtyDaysAgo },
      pharmacyStatus: { $in: ['not_dispensed', 'partially_dispensed'] }
    });
    
    res.json({
      success: true,
      prescriptions,
      stats: {
        total,
        activePrescriptions,
        lastPrescriptionDate: prescriptions[0]?.issuedAt || null
      },
      pagination: recent ? null : {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching prescriptions:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch prescriptions'
    });
  }
};

// Get lab reports
exports.getLabReports = async (req, res) => {
  try {
    const { 
      status,
      pathologyId,
      startDate,
      endDate,
      page = 1,
      limit = 20 
    } = req.query;
    
    // Get profile ID
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const filter = { 
      patientId: profile._id
    };
    
    if (status) filter.status = status;
    if (pathologyId) filter.pathologyId = pathologyId;
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      filter.scheduledDate = {
        $gte: start,
        $lte: end
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const labTests = await LabTest.find(filter)
      .populate('pathologyId', 'labName address phone')
      .populate('doctorId', 'name specialization')
      .populate('appointmentId', 'appointmentDate')
      .sort({ scheduledDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await LabTest.countDocuments(filter);
    
    // Get pending tests
    const pendingTests = await LabTest.countDocuments({
      patientId: profile._id,
      status: { $in: ['requested', 'scheduled', 'sample_collected', 'processing'] }
    });
    
    res.json({
      success: true,
      labTests,
      stats: {
        total,
        pendingTests,
        completedTests: total - pendingTests
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching lab reports:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch lab reports'
    });
  }
};

// Get invoices
exports.getInvoices = async (req, res) => {
  try {
    const { 
      status,
      type,
      startDate,
      endDate,
      page = 1,
      limit = 20 
    } = req.query;
    
    // Get profile ID
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const filter = { 
      patientId: profile._id
    };
    
    if (status) filter.status = status;
    if (type) filter.invoiceType = type;
    
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      filter.invoiceDate = {
        $gte: start,
        $lte: end
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const invoices = await Invoice.find(filter)
      .populate('appointmentId', 'appointmentDate')
      .populate('pharmacySaleId', 'saleNumber')
      .populate('labTestId', 'testName')
      .sort({ invoiceDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Invoice.countDocuments(filter);
    
    // Get financial summary
    const financialSummary = await Invoice.aggregate([
      {
        $match: {
          patientId: profile._id
        }
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$totalAmount' },
          totalPaid: { $sum: '$amountPaid' },
          totalDue: { $sum: '$balanceDue' },
          totalInvoices: { $sum: 1 },
          paidInvoices: {
            $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] }
          },
          pendingInvoices: {
            $sum: { $cond: [{ $in: ['$status', ['sent', 'partial', 'overdue']] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Get recent payments
    const recentPayments = await Invoice.find({
      patientId: profile._id,
      status: 'paid'
    })
    .sort({ paidAt: -1 })
    .limit(5)
    .select('invoiceNumber totalAmount paidAt paymentMethod');
    
    res.json({
      success: true,
      invoices,
      financialSummary: financialSummary[0] || {
        totalAmount: 0,
        totalPaid: 0,
        totalDue: 0,
        totalInvoices: 0,
        paidInvoices: 0,
        pendingInvoices: 0
      },
      recentPayments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching invoices:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoices'
    });
  }
};

// Get dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    // Get profile
    const profile = await PatientProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);
    
    // Appointment statistics
    const appointmentStats = await Appointment.aggregate([
      {
        $match: {
          patientId: profile._id,
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: null,
          totalAppointments: { $sum: 1 },
          completedAppointments: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          upcomingAppointments: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'confirmed', 'accepted']] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Prescription statistics
    const prescriptionStats = await Prescription.aggregate([
      {
        $match: {
          patientId: profile._id,
          issuedAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: null,
          totalPrescriptions: { $sum: 1 },
          activePrescriptions: {
            $sum: { $cond: [{ $in: ['$pharmacyStatus', ['not_dispensed', 'partially_dispensed']] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Lab test statistics
    const labTestStats = await LabTest.aggregate([
      {
        $match: {
          patientId: profile._id,
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: null,
          totalLabTests: { $sum: 1 },
          pendingTests: {
            $sum: { $cond: [{ $in: ['$status', ['requested', 'scheduled', 'sample_collected', 'processing']] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Financial statistics
    const financialStats = await Invoice.aggregate([
      {
        $match: {
          patientId: profile._id,
          invoiceDate: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: null,
          totalSpent: { $sum: '$totalAmount' },
          pendingPayment: {
            $sum: { $cond: [{ $in: ['$status', ['sent', 'partial', 'overdue']] }, '$balanceDue', 0] }
          }
        }
      }
    ]);
    
    // Get upcoming appointments
    const upcomingAppointments = await Appointment.find({
      patientId: profile._id,
      appointmentDate: { $gte: today },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    })
    .populate('doctorId', 'name specialization')
    .populate('physioId', 'name services')
    .sort({ appointmentDate: 1 })
    .limit(5);
    
    // Get recent prescriptions
    const recentPrescriptions = await Prescription.find({
      patientId: profile._id
    })
    .populate('doctorId', 'name specialization')
    .sort({ issuedAt: -1 })
    .limit(3);
    
    // Get health summary
    const healthSummary = {
      age: profile.age,
      bloodGroup: profile.bloodGroup,
      bmi: profile.bmi,
      chronicConditions: profile.chronicConditions?.length || 0,
      allergies: profile.allergies?.length || 0,
      lastConsultation: profile.lastConsultation
    };
    
    res.json({
      success: true,
      stats: {
        appointments: appointmentStats[0] || {
          totalAppointments: 0,
          completedAppointments: 0,
          upcomingAppointments: 0
        },
        prescriptions: prescriptionStats[0] || {
          totalPrescriptions: 0,
          activePrescriptions: 0
        },
        labTests: labTestStats[0] || {
          totalLabTests: 0,
          pendingTests: 0
        },
        financial: financialStats[0] || {
          totalSpent: 0,
          pendingPayment: 0
        }
      },
      upcomingAppointments,
      recentPrescriptions,
      healthSummary,
      profile: {
        name: profile.name,
        patientId: profile.patientId,
        registeredAt: profile.registeredAt
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
};