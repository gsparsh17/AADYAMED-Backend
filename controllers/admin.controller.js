const User = require('../models/User');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const CommissionSettings = require('../models/CommissionSettings');
const AuditLog = require('../models/AuditLog');

exports.getDashboardStats = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    
    // Get user counts
    const userCounts = await User.aggregate([
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Get pending verifications
    const pendingVerifications = {
      doctors: await DoctorProfile.countDocuments({ verificationStatus: 'pending' }),
      physios: await PhysiotherapistProfile.countDocuments({ verificationStatus: 'pending' }),
      pathology: await PathologyProfile.countDocuments({ verificationStatus: 'pending' })
    };
    
    // Get today's appointments
    const Appointment = require('../models/Appointment');
    const todaysAppointments = await Appointment.countDocuments({
      appointmentDate: { $gte: startOfDay }
    });
    
    // Get monthly revenue
    const Commission = require('../models/Commission');
    const monthlyRevenue = await Commission.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfMonth },
          payoutStatus: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$platformCommission' }
        }
      }
    ]);
    
    // Get recent activities
    const recentActivities = await AuditLog.find()
      .sort({ timestamp: -1 })
      .limit(10)
      .populate('userId', 'email role');

      const Medicine = require('../models/Medicine');
    const PharmacySale = require('../models/PharmacySale');
    
    const pharmacyStats = {
      totalMedicines: await Medicine.countDocuments({ isActive: true }),
      lowStockMedicines: await Medicine.countDocuments({ 
        isActive: true,
        quantity: { $lte: { $ifNull: ['$reorderLevel', 10] } }
      }),
      todaySales: await PharmacySale.countDocuments({
        saleDate: { $gte: startOfDay },
        status: 'dispensed'
      }),
      monthlyPharmacyRevenue: await PharmacySale.aggregate([
        {
          $match: {
            saleDate: { $gte: startOfMonth },
            status: 'dispensed'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalAmount' }
          }
        }
      ])
    };
    
    res.json({
      success: true,
      stats: {
        userCounts,
        pendingVerifications,
        todaysAppointments,
        pharmacyStats,
        monthlyRevenue: monthlyRevenue[0]?.total || 0,
        recentActivities
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.verifyProfessional = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { id, type, status, notes } = req.body;
    
    let ProfessionalModel;
    switch(type) {
      case 'doctor':
        ProfessionalModel = DoctorProfile;
        break;
      case 'physiotherapist':
        ProfessionalModel = PhysiotherapistProfile;
        break;
      case 'pathology':
        ProfessionalModel = PathologyProfile;
        break;
      default:
        return res.status(400).json({ message: 'Invalid professional type' });
    }
    
    const professional = await ProfessionalModel.findById(id);
    if (!professional) {
      return res.status(404).json({ message: 'Professional not found' });
    }
    
    professional.verificationStatus = status;
    professional.adminNotes = notes;
    professional.verifiedBy = req.user.id;
    professional.verifiedAt = new Date();
    
    if (status === 'approved') {
      // Update user verification status
      await User.findByIdAndUpdate(professional.userId, { 
        isVerified: true 
      });
      
      // Send approval notification
      await sendVerificationNotification(professional, 'approved');
    } else if (status === 'rejected') {
      // Send rejection notification
      await sendVerificationNotification(professional, 'rejected');
    }
    
    await professional.save();
    
    res.json({ success: true, professional });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getProfessionals = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { 
      type, 
      verificationStatus,
      specialization,
      page = 1,
      limit = 20 
    } = req.query;
    
    let Model;
    switch(type) {
      case 'doctor':
        Model = DoctorProfile;
        break;
      case 'physiotherapist':
        Model = PhysiotherapistProfile;
        break;
      case 'pathology':
        Model = PathologyProfile;
        break;
      default:
        return res.status(400).json({ message: 'Invalid type' });
    }
    
    const filter = {};
    if (verificationStatus) filter.verificationStatus = verificationStatus;
    if (specialization) filter.specialization = { $in: [specialization] };
    
    const professionals = await Model.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('userId', 'email isActive lastLogin');
    
    const total = await Model.countDocuments(filter);
    
    res.json({
      success: true,
      professionals,
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

exports.updateCommissionSettings = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const settings = await CommissionSettings.getSettings();
    
    // Update settings
    Object.keys(req.body).forEach(key => {
      if (settings[key] !== undefined) {
        settings[key] = req.body[key];
      }
    });
    
    settings.updatedBy = req.user.id;
    settings.updatedAt = new Date();
    settings.version += 1;
    
    await settings.save();
    
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAuditLogs = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { 
      userId, 
      action, 
      entity,
      startDate,
      endDate,
      page = 1,
      limit = 50 
    } = req.query;
    
    const filter = {};
    
    if (userId) filter.userId = userId;
    if (action) filter.action = action;
    if (entity) filter.entity = entity;
    if (startDate && endDate) {
      filter.timestamp = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const logs = await AuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('userId', 'email role');
    
    const total = await AuditLog.countDocuments(filter);
    
    res.json({
      success: true,
      logs,
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

// Helper function
async function sendVerificationNotification(professional, status) {
  // Implementation for sending notifications
}