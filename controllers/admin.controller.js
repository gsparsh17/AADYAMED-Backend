const mongoose = require('mongoose');
const User = require('../models/User');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const PharmacyProfile = require('../models/PharmacyProfile');
const Appointment = require('../models/Appointment');
const Referral = require('../models/Referral');
const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');
const AuditLog = require('../models/AuditLog');
const Invoice = require('../models/Invoice');
const LabTest = require('../models/LabTest');
const Medicine = require('../models/Medicine');
const PharmacySale = require('../models/PharmacySale');
const Payout = require('../models/Payout');

// ========== DASHBOARD FUNCTIONS ==========

/**
 * @desc    Get dashboard statistics
 * @route   GET /api/admin/dashboard
 * @access  Admin
 */
exports.getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - 7);
    
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    // Parallel queries for performance
    const [
      totalUsers,
      activeDoctors,
      totalAppointments,
      todayRevenue,
      pendingVerifications,
      totalPathology,
      totalPharmacy,
      appointmentsToday,
      pendingPayouts,
      systemHealth
    ] = await Promise.all([
      // Total users count
      User.countDocuments(),
      
      // Active doctors count
      DoctorProfile.countDocuments({ verificationStatus: 'approved' }),
      
      // Total appointments
      Appointment.countDocuments(),
      
      // Today's revenue
      Invoice.aggregate([
        {
          $match: {
            invoiceDate: { $gte: today },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$totalAmount' }
          }
        }
      ]),
      
      // Pending verifications (doctors + physio + pathology)
      Promise.all([
        DoctorProfile.countDocuments({ verificationStatus: 'pending' }),
        PhysiotherapistProfile.countDocuments({ verificationStatus: 'pending' }),
        PathologyProfile.countDocuments({ verificationStatus: 'pending' })
      ]).then(([doctors, physios, pathology]) => doctors + physios + pathology),
      
      // Total pathology centers
      PathologyProfile.countDocuments({ verificationStatus: 'approved' }),
      
      // Total pharmacies
      Pharmacy.countDocuments({ status: 'Active' }),
      
      // Today's appointments count
      Appointment.countDocuments({
        appointmentDate: { $gte: today },
        status: { $in: ['pending', 'confirmed', 'accepted'] }
      }),
      
      // Pending payouts amount
      Commission.aggregate([
        {
          $match: { payoutStatus: 'pending' }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$platformCommission' }
          }
        }
      ]),
      
      // System health check
      checkSystemHealth()
    ]);
    
    // Get weekly trend data
    const weeklyTrend = await getWeeklyTrend();
    
    // Get user distribution by role
    const userDistribution = await User.aggregate([
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const stats = {
      totalUsers,
      activeDoctors,
      totalAppointments,
      todayRevenue: todayRevenue[0]?.total || 0,
      pendingVerifications,
      totalPathology,
      totalPharmacy,
      systemHealth: systemHealth.score,
      appointmentsToday,
      pendingPayouts: pendingPayouts[0]?.total || 0,
      weeklyTrend,
      userDistribution: userDistribution.reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {})
    };
    
    res.json({
      success: true,
      stats
    });
    
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard statistics'
    });
  }
};

/**
 * @desc    Get recent activities
 * @route   GET /api/admin/recent-activities
 * @access  Admin
 */
exports.getRecentActivities = async (req, res) => {
  try {
    const { limit = 5 } = req.query;
    
    // Get recent audit logs
    const auditLogs = await AuditLog.find()
      .populate('userId', 'name email role')
      .sort({ timestamp: -1 })
      .limit(parseInt(limit));
    
    // Format activities
    const activities = auditLogs.map(log => {
      let action = log.action;
      let type = 'system';
      let user = log.userId?.name || 'System';
      let time = formatTimeAgo(log.timestamp);
      
      // Categorize by action type
      if (log.action.includes('USER')) type = 'user';
      else if (log.action.includes('APPOINTMENT')) type = 'appointment';
      else if (log.action.includes('VERIFY')) type = 'verification';
      else if (log.action.includes('PAYMENT') || log.action.includes('COMMISSION') || log.action.includes('PAYOUT')) type = 'payment';
      
      return {
        id: log._id,
        type,
        action: formatActionText(log.action),
        time,
        user,
        details: log.details || {}
      };
    });
    
    res.json({
      success: true,
      activities
    });
    
  } catch (error) {
    console.error('Recent activities error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent activities'
    });
  }
};

/**
 * @desc    Get chart data for analytics
 * @route   GET /api/admin/analytics/chart
 * @access  Admin
 */
exports.getChartData = async (req, res) => {
  try {
    const { period = 'week' } = req.query;
    
    let startDate, endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    
    switch(period) {
      case 'week':
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'month':
        startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'year':
        startDate = new Date();
        startDate.setFullYear(startDate.getFullYear() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
      default:
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        startDate.setHours(0, 0, 0, 0);
    }
    
    // Get appointments data
    const appointmentsData = await Appointment.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 },
          revenue: { $sum: '$consultationFee' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);
    
    // Get user registrations
    const usersData = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);
    
    // Format chart data based on period
    const chartData = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    if (period === 'week') {
      // Create a map for quick lookup
      const appointmentsMap = new Map();
      appointmentsData.forEach(item => {
        const date = new Date(item._id.year, item._id.month - 1, item._id.day);
        appointmentsMap.set(date.getDay(), item);
      });
      
      const usersMap = new Map();
      usersData.forEach(item => {
        const date = new Date(item._id.year, item._id.month - 1, item._id.day);
        usersMap.set(date.getDay(), item);
      });
      
      for (let i = 0; i < 7; i++) {
        const appointment = appointmentsMap.get(i) || { count: 0, revenue: 0 };
        const user = usersMap.get(i) || { count: 0 };
        
        chartData.push({
          day: dayNames[i],
          appointments: appointment.count,
          revenue: appointment.revenue,
          users: user.count
        });
      }
    } else if (period === 'month') {
      // Group by day of month
      const daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
      
      for (let i = 1; i <= daysInMonth; i++) {
        const appointment = appointmentsData.find(d => d._id.day === i) || { count: 0, revenue: 0 };
        const user = usersData.find(d => d._id.day === i) || { count: 0 };
        
        chartData.push({
          day: i.toString(),
          appointments: appointment.count,
          revenue: appointment.revenue,
          users: user.count
        });
      }
    } else {
      // Group by month
      for (let i = 1; i <= 12; i++) {
        const appointment = appointmentsData.find(d => d._id.month === i) || { count: 0, revenue: 0 };
        const user = usersData.find(d => d._id.month === i) || { count: 0 };
        
        chartData.push({
          day: monthNames[i - 1],
          appointments: appointment.count,
          revenue: appointment.revenue,
          users: user.count
        });
      }
    }
    
    res.json({
      success: true,
      data: chartData
    });
    
  } catch (error) {
    console.error('Chart data error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch chart data'
    });
  }
};

// ========== USERS MANAGEMENT ==========

/**
 * @desc    Get all users with filters
 * @route   GET /api/admin/users
 * @access  Admin
 */
exports.getUsers = async (req, res) => {
  try {
    const {
      role,
      status,
      isVerified,
      search,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    const filter = {};
    
    if (role) filter.role = role;
    if (status === 'active') filter.isActive = true;
    if (status === 'inactive') filter.isActive = false;
    if (isVerified !== undefined) filter.isVerified = isVerified === 'true';
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    
    const users = await User.find(filter)
      .select('-password -resetPasswordToken -resetPasswordExpire -emailVerificationToken -emailVerificationExpires')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await User.countDocuments(filter);
    
    // Get profile completion stats
    const usersWithProfiles = await Promise.all(
      users.map(async (user) => {
        let profile = null;
        
        if (user.profileId && user.profileModel) {
          try {
            const Model = mongoose.model(user.profileModel);
            profile = await Model.findById(user.profileId).select('name verificationStatus');
          } catch (e) {
            console.error('Error fetching profile:', e);
          }
        }
        
        return {
          ...user.toObject(),
          profileDetails: profile
        };
      })
    );
    
    res.json({
      success: true,
      users: usersWithProfiles,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
};

/**
 * @desc    Get user by ID with full details
 * @route   GET /api/admin/users/:id
 * @access  Admin
 */
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const user = await User.findById(id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    // Get profile if exists
    let profile = null;
    if (user.profileId && user.profileModel) {
      try {
        const Model = mongoose.model(user.profileModel);
        profile = await Model.findById(user.profileId);
      } catch (e) {
        console.error('Error fetching profile:', e);
      }
    }
    
    // Get user statistics based on role
    let stats = {};
    
    if (user.role === 'doctor') {
      stats = await getDoctorStats(user.profileId);
    } else if (user.role === 'physio') {
      stats = await getPhysioStats(user.profileId);
    } else if (user.role === 'patient') {
      stats = await getPatientStats(user.profileId);
    } else if (user.role === 'pathology') {
      stats = await getPathologyStats(user.profileId);
    } else if (user.role === 'pharmacy') {
      stats = await getPharmacyStats(user.profileId);
    }
    
    res.json({
      success: true,
      user,
      profile,
      stats
    });
    
  } catch (error) {
    console.error('Get user by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch user details'
    });
  }
};

/**
 * @desc    Toggle user active status
 * @route   PUT /api/admin/users/:id/toggle-active
 * @access  Admin
 */
exports.toggleUserActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    // Prevent deactivating own account
    if (user._id.toString() === req.user.id) {
      return res.status(400).json({
        success: false,
        error: 'You cannot deactivate your own account'
      });
    }
    
    user.isActive = !user.isActive;
    await user.save();
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: user.isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entity: 'User',
      entityId: user._id,
      details: {
        reason: reason || `User ${user.isActive ? 'activated' : 'deactivated'} by admin`,
        previousStatus: !user.isActive
      },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user._id,
        isActive: user.isActive
      }
    });
    
  } catch (error) {
    console.error('Toggle user active error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update user status'
    });
  }
};

/**
 * @desc    Force verify user email
 * @route   PUT /api/admin/users/:id/force-verify
 * @access  Admin
 */
exports.forceVerifyUser = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find the user first to get their role
    const user = await User.findById(id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    // Update user verification status
    const updatedUser = await User.findByIdAndUpdate(
      id,
      {
        isVerified: true,
        emailVerificationToken: undefined,
        emailVerificationExpires: undefined
      },
      { new: true }
    );
    
    // Update the corresponding profile based on user role
    let updatedProfile = null;
    const verificationData = {
      verificationStatus: 'approved',
      verifiedAt: new Date(),
      verifiedBy: req.user.id,
      adminNotes: req.body.notes || 'Force verified by admin'
    };

    switch (user.role) {
      case 'doctor':
        updatedProfile = await DoctorProfile.findOneAndUpdate(
          { userId: id },
          verificationData,
          { new: true }
        );
        break;
        
      case 'physio':
        updatedProfile = await PhysiotherapistProfile.findOneAndUpdate(
          { userId: id },
          verificationData,
          { new: true }
        );
        break;
        
      case 'pathology':
        updatedProfile = await PathologyProfile.findOneAndUpdate(
          { userId: id },
          verificationData,
          { new: true }
        );
        break;
        
      case 'pharmacy':
        updatedProfile = await PharmacyProfile.findOneAndUpdate(
          { userId: id },
          verificationData,
          { new: true }
        );
        break;
        
      case 'patient':
        // Patients don't need verification status in their profile
        // but you can still log that they were verified
        console.log(`Patient ${id} verified by admin`);
        break;
        
      default:
        console.log(`Unknown role ${user.role} for user ${id}`);
    }
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'USER_FORCE_VERIFIED',
      entity: 'User',
      entityId: user._id,
      details: { 
        verifiedBy: req.user.id,
        userRole: user.role,
        profileUpdated: !!updatedProfile,
        notes: req.body.notes || 'No notes provided'
      },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: `User verified successfully. ${updatedProfile ? 'Profile also updated.' : ''}`,
      user: updatedUser,
      profile: updatedProfile || null
    });
    
  } catch (error) {
    console.error('Force verify user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify user',
      details: error.message
    });
  }
};

// ========== PROFESSIONALS MANAGEMENT ==========

/**
 * @desc    Get all professionals with filters
 * @route   GET /api/admin/professionals
 * @access  Admin
 */
/**
 * @desc    Get all professionals with filters
 * @route   GET /api/admin/professionals
 * @access  Admin
 */
exports.getProfessionals = async (req, res) => {
  try {
    const {
      type,
      verificationStatus,
      specialization,
      search,
      page = 1,
      limit = 20
    } = req.query;
    
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;
    
    // Build filter
    const buildFilter = (params) => {
      const filter = {};
      
      if (params.verificationStatus && params.verificationStatus !== 'all') {
        filter.verificationStatus = params.verificationStatus;
      }
      
      if (params.specialization) {
        filter.specialization = { $in: [params.specialization] };
      }
      
      if (params.search) {
        filter.$or = [
          { name: { $regex: params.search, $options: 'i' } },
          { email: { $regex: params.search, $options: 'i' } },
          { phone: { $regex: params.search, $options: 'i' } },
          { labName: { $regex: params.search, $options: 'i' } }
        ];
      }
      
      return filter;
    };
    
    const filterParams = { verificationStatus, specialization, search };
    
    // Define comprehensive field selections for each type
    const doctorFields = 'name specialization consultationFee homeVisitFee averageRating totalConsultations totalEarnings verificationStatus clinicAddress qualifications licenseNumber experienceYears gender dateOfBirth languages about availability commissionRate pendingCommission paidCommission adminNotes verifiedAt verifiedBy bankDetails contactNumber email profileImage createdAt updatedAt';
    
    const physioFields = 'name specialization consultationFee homeVisitFee averageRating totalConsultations totalEarnings verificationStatus clinicAddress qualifications licenseNumber experienceYears gender dateOfBirth languages about services availability commissionRate pendingCommission paidCommission adminNotes verifiedAt verifiedBy bankDetails contactNumber email profileImage servesAreas createdAt updatedAt';
    
    const pathologyFields = 'labName services homeCollectionAvailable homeCollectionCharges averageRating totalTestsConducted totalEarnings verificationStatus address operatingHours testSlots accreditation licenses contactPerson phone email website commissionRate adminNotes verifiedAt verifiedBy bankDetails profileImage registrationNumber createdAt updatedAt';
    
    // If specific type is requested
    if (type === 'doctor') {
      const filter = buildFilter({ ...filterParams, specialization: filterParams.specialization });
      
      const [professionals, total] = await Promise.all([
        DoctorProfile.find(filter)
          .populate('userId', 'email isActive lastLogin loginCount createdAt')
          .select(doctorFields)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        DoctorProfile.countDocuments(filter)
      ]);
      
      return res.json({
        success: true,
        professionals,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      });
    }
    
    if (type === 'physio') {
      const filter = buildFilter({ ...filterParams, specialization: filterParams.specialization });
      
      const [professionals, total] = await Promise.all([
        PhysiotherapistProfile.find(filter)
          .populate('userId', 'email isActive lastLogin loginCount createdAt')
          .select(physioFields)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        PhysiotherapistProfile.countDocuments(filter)
      ]);
      
      return res.json({
        success: true,
        professionals,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      });
    }
    
    if (type === 'pathology') {
      const filter = buildFilter({ verificationStatus: filterParams.verificationStatus, search: filterParams.search });
      
      const [professionals, total] = await Promise.all([
        PathologyProfile.find(filter)
          .populate('userId', 'email isActive lastLogin loginCount createdAt')
          .select(pathologyFields)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        PathologyProfile.countDocuments(filter)
      ]);
      
      return res.json({
        success: true,
        professionals,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      });
    }
    
    // Get all types with pagination for each
    const [doctors, physios, pathology] = await Promise.all([
      DoctorProfile.find(buildFilter({ ...filterParams, specialization: filterParams.specialization }))
        .populate('userId', 'email isActive lastLogin loginCount createdAt')
        .select(doctorFields)
        .sort({ createdAt: -1 })
        .limit(limitNum),
      
      PhysiotherapistProfile.find(buildFilter({ ...filterParams, specialization: filterParams.specialization }))
        .populate('userId', 'email isActive lastLogin loginCount createdAt')
        .select(physioFields)
        .sort({ createdAt: -1 })
        .limit(limitNum),
      
      PathologyProfile.find(buildFilter({ verificationStatus: filterParams.verificationStatus, search: filterParams.search }))
        .populate('userId', 'email isActive lastLogin loginCount createdAt')
        .select(pathologyFields)
        .sort({ createdAt: -1 })
        .limit(limitNum)
    ]);
    
    // Get total counts for each type
    const [totalDoctors, totalPhysios, totalPathology] = await Promise.all([
      DoctorProfile.countDocuments(buildFilter({ ...filterParams, specialization: filterParams.specialization })),
      PhysiotherapistProfile.countDocuments(buildFilter({ ...filterParams, specialization: filterParams.specialization })),
      PathologyProfile.countDocuments(buildFilter({ verificationStatus: filterParams.verificationStatus, search: filterParams.search }))
    ]);
    
    res.json({
      success: true,
      professionals: {
        doctors,
        physios,
        pathology
      },
      pagination: {
        doctors: {
          page: pageNum,
          limit: limitNum,
          total: totalDoctors,
          pages: Math.ceil(totalDoctors / limitNum)
        },
        physios: {
          page: pageNum,
          limit: limitNum,
          total: totalPhysios,
          pages: Math.ceil(totalPhysios / limitNum)
        },
        pathology: {
          page: pageNum,
          limit: limitNum,
          total: totalPathology,
          pages: Math.ceil(totalPathology / limitNum)
        }
      }
    });
    
  } catch (error) {
    console.error('Get professionals error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch professionals'
    });
  }
};

// Helper function for building filters (define this outside or at the top of the file)
function buildFilter({ verificationStatus, specialization, search }) {
  const filter = {};
  
  if (verificationStatus && verificationStatus !== 'all') {
    filter.verificationStatus = verificationStatus;
  }
  
  if (specialization) {
    filter.specialization = { $in: [specialization] };
  }
  
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { labName: { $regex: search, $options: 'i' } },
      { contactPerson: { $regex: search, $options: 'i' } }
    ];
  }
  
  return filter;
}

/**
 * @desc    Get professional by ID
 * @route   GET /api/admin/professionals/:type/:id
 * @access  Admin
 */
exports.getProfessionalById = async (req, res) => {
  try {
    const { type, id } = req.params;
    
    let Model;
    if (type === 'doctor') Model = DoctorProfile;
    else if (type === 'physio') Model = PhysiotherapistProfile;
    else if (type === 'pathology') Model = PathologyProfile;
    else {
      return res.status(400).json({
        success: false,
        error: 'Invalid professional type'
      });
    }
    
    const professional = await Model.findById(id)
      .populate('userId', 'email phone isVerified isActive lastLogin');
    
    if (!professional) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }
    
    // Get recent appointments
    const recentAppointments = await Appointment.find({
      [type === 'doctor' ? 'doctorId' : type === 'physio' ? 'physioId' : 'pathologyId']: id,
      professionalType: type
    })
      .populate('patientId', 'name')
      .sort({ appointmentDate: -1 })
      .limit(5);
    
    // Get commission history
    const commissionHistory = await Commission.find({
      professionalId: id,
      professionalType: type
    })
      .sort({ createdAt: -1 })
      .limit(10);
    
    res.json({
      success: true,
      professional,
      recentAppointments,
      commissionHistory
    });
    
  } catch (error) {
    console.error('Get professional by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch professional details'
    });
  }
};

/**
 * @desc    Verify professional
 * @route   POST /api/admin/professionals/:type/:id/verify
 * @access  Admin
 */
exports.verifyProfessional = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { status, notes } = req.body;
    
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Must be approved, rejected, or pending'
      });
    }
    
    let Model;
    if (type === 'doctor') Model = DoctorProfile;
    else if (type === 'physio') Model = PhysiotherapistProfile;
    else if (type === 'pathology') Model = PathologyProfile;
    else {
      return res.status(400).json({
        success: false,
        error: 'Invalid professional type'
      });
    }
    
    const professional = await Model.findById(id);
    if (!professional) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }
    
    const oldStatus = professional.verificationStatus;
    
    professional.verificationStatus = status;
    professional.adminNotes = notes || professional.adminNotes;
    professional.verifiedAt = new Date();
    professional.verifiedBy = req.user.id;
    
    await professional.save();
    
    // Update user verification status if approved
    if (status === 'approved') {
      await User.findByIdAndUpdate(professional.userId, { isVerified: true });
    }
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: `PROFESSIONAL_${status.toUpperCase()}`,
      entity: type.charAt(0).toUpperCase() + type.slice(1),
      entityId: professional._id,
      details: {
        oldStatus,
        newStatus: status,
        notes,
        professionalName: professional.name || professional.labName
      },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: `Professional ${status} successfully`,
      professional
    });
    
  } catch (error) {
    console.error('Verify professional error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify professional'
    });
  }
};

/**
 * @desc    Update professional notes
 * @route   PUT /api/admin/professionals/:type/:id/notes
 * @access  Admin
 */
exports.updateProfessionalNotes = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { notes } = req.body;
    
    let Model;
    if (type === 'doctor') Model = DoctorProfile;
    else if (type === 'physio') Model = PhysiotherapistProfile;
    else if (type === 'pathology') Model = PathologyProfile;
    else {
      return res.status(400).json({
        success: false,
        error: 'Invalid professional type'
      });
    }
    
    const professional = await Model.findByIdAndUpdate(
      id,
      { adminNotes: notes },
      { new: true }
    );
    
    if (!professional) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Notes updated successfully',
      professional
    });
    
  } catch (error) {
    console.error('Update professional notes error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update notes'
    });
  }
};

// ========== APPOINTMENTS MANAGEMENT ==========

/**
 * @desc    Get all appointments with filters
 * @route   GET /api/admin/appointments
 * @access  Admin
 */
exports.getAppointments = async (req, res) => {
  try {
    const {
      status,
      professionalType,
      startDate,
      endDate,
      patientId,
      professionalId,
      page = 1,
      limit = 20
    } = req.query;
    
    const filter = {};
    
    if (status) filter.status = status;
    if (professionalType) filter.professionalType = professionalType;
    if (patientId) filter.patientId = patientId;
    
    if (professionalId && professionalType) {
      const field = professionalType === 'doctor' ? 'doctorId' :
                    professionalType === 'physio' ? 'physioId' :
                    'pathologyId';
      filter[field] = professionalId;
    }
    
    if (startDate && endDate) {
      filter.appointmentDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone')
      .populate('doctorId', 'name specialization')
      .populate('physioId', 'name services')
      .populate('pathologyId', 'labName')
      .populate('referralId', 'requirement')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Appointment.countDocuments(filter);
    
    // Get statistics
    const stats = await Appointment.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' }
        }
      }
    ]);
    
    res.json({
      success: true,
      appointments,
      stats: stats.reduce((acc, curr) => {
        acc[curr._id] = { count: curr.count, revenue: curr.totalRevenue };
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
    console.error('Get appointments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointments'
    });
  }
};

/**
 * @desc    Get appointment by ID
 * @route   GET /api/admin/appointments/:id
 * @access  Admin
 */
exports.getAppointmentById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const appointment = await Appointment.findById(id)
      .populate('patientId')
      .populate('doctorId')
      .populate('physioId')
      .populate('pathologyId')
      .populate('referralId')
      .populate('prescriptionId');
    
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }
    
    // Get invoice if exists
    const invoice = await Invoice.findOne({ appointmentId: id });
    
    // Get commission if exists
    const commission = await Commission.findOne({ appointmentId: id });
    
    res.json({
      success: true,
      appointment,
      invoice,
      commission
    });
    
  } catch (error) {
    console.error('Get appointment by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch appointment details'
    });
  }
};

/**
 * @desc    Update appointment status
 * @route   PUT /api/admin/appointments/:id/status
 * @access  Admin
 */
exports.updateAppointmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }
    
    const oldStatus = appointment.status;
    appointment.status = status;
    
    if (status === 'cancelled') {
      appointment.cancellationReason = reason;
      appointment.cancelledBy = 'admin';
      appointment.cancelledAt = new Date();
    }
    
    await appointment.save();
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'APPOINTMENT_STATUS_UPDATED',
      entity: 'Appointment',
      entityId: appointment._id,
      details: {
        oldStatus,
        newStatus: status,
        reason
      },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: 'Appointment status updated successfully',
      appointment
    });
    
  } catch (error) {
    console.error('Update appointment status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update appointment status'
    });
  }
};

/**
 * @desc    Update appointment payment
 * @route   PUT /api/admin/appointments/:id/payment
 * @access  Admin
 */
exports.updateAppointmentPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentStatus, paymentMethod, notes } = req.body;
    
    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: 'Appointment not found'
      });
    }
    
    appointment.paymentStatus = paymentStatus;
    appointment.paymentMethod = paymentMethod;
    appointment.paymentNotes = notes;
    
    await appointment.save();
    
    // Update or create invoice
    let invoice = await Invoice.findOne({ appointmentId: id });
    
    if (invoice) {
      invoice.status = paymentStatus === 'paid' ? 'paid' : 'sent';
      invoice.paymentMethod = paymentMethod;
      await invoice.save();
    } else if (paymentStatus === 'paid') {
      invoice = await Invoice.create({
        invoiceType: 'appointment',
        appointmentId: id,
        patientId: appointment.patientId,
        items: [{
          description: `${appointment.professionalType} consultation`,
          quantity: 1,
          unitPrice: appointment.consultationFee,
          amount: appointment.consultationFee
        }],
        subtotal: appointment.consultationFee,
        totalAmount: appointment.consultationFee,
        amountPaid: appointment.consultationFee,
        status: 'paid',
        paymentMethod
      });
    }
    
    res.json({
      success: true,
      message: 'Payment status updated successfully',
      appointment,
      invoice
    });
    
  } catch (error) {
    console.error('Update appointment payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update payment status'
    });
  }
};

// ========== PAYMENTS & COMMISSIONS ==========

/**
 * @desc    Get payments and commissions
 * @route   GET /api/admin/payments
 * @access  Admin
 */
exports.getPayments = async (req, res) => {
  try {
    const {
      status,
      professionalType,
      startDate,
      endDate,
      page = 1,
      limit = 20
    } = req.query;
    
    const filter = {};
    
    if (status) filter.payoutStatus = status;
    if (professionalType) filter.professionalType = professionalType;
    
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const commissions = await Commission.find(filter)
      .populate({
        path: 'professionalId',
        select: 'name labName specialization'
      })
      .populate('appointmentId')
      .populate('patientId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Commission.countDocuments(filter);
    
    // Get summary
    const summary = await Commission.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: '$payoutStatus',
          totalAmount: { $sum: '$platformCommission' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Get totals
    const totals = await Commission.aggregate([
      {
        $match: filter
      },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: '$platformCommission' },
          totalEarnings: { $sum: '$professionalEarning' },
          totalConsultations: { $sum: 1 },
          paidAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
          },
          pendingAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
          },
          processingAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'processing'] }, '$platformCommission', 0] }
          }
        }
      }
    ]);
    
    res.json({
      success: true,
      commissions,
      summary: summary.reduce((acc, curr) => {
        acc[curr._id] = { amount: curr.totalAmount, count: curr.count };
        return acc;
      }, {}),
      totals: totals[0] || {
        totalCommission: 0,
        totalEarnings: 0,
        totalConsultations: 0,
        paidAmount: 0,
        pendingAmount: 0,
        processingAmount: 0
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payments'
    });
  }
};

/**
 * @desc    Get commission report
 * @route   GET /api/admin/payments/commissions
 * @access  Admin
 */
exports.getCommissionReport = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'month' } = req.query;
    
    const matchStage = {};
    
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    let groupStage;
    
    if (groupBy === 'month') {
      groupStage = {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultations: { $sum: 1 },
        paidAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
        },
        pendingAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
        }
      };
    } else if (groupBy === 'professional') {
      groupStage = {
        _id: {
          professionalId: '$professionalId',
          professionalType: '$professionalType'
        },
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultations: { $sum: 1 }
      };
    } else if (groupBy === 'cycle') {
      groupStage = {
        _id: '$commissionCycle.cycleNumber',
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultations: { $sum: 1 },
        paidAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
        },
        pendingAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
        }
      };
    }
    
    const report = await Commission.aggregate([
      { $match: matchStage },
      { $group: groupStage },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get professional details for professional grouping
    if (groupBy === 'professional') {
      for (const item of report) {
        const { professionalId, professionalType } = item._id;
        
        if (professionalType === 'doctor') {
          const doctor = await DoctorProfile.findById(professionalId).select('name specialization');
          item.professional = doctor;
        } else if (professionalType === 'physio') {
          const physio = await PhysiotherapistProfile.findById(professionalId).select('name services');
          item.professional = physio;
        } else if (professionalType === 'pathology') {
          const pathology = await PathologyProfile.findById(professionalId).select('labName');
          item.professional = pathology;
        }
      }
    }
    
    res.json({
      success: true,
      report
    });
    
  } catch (error) {
    console.error('Get commission report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission report'
    });
  }
};

/**
 * @desc    Get commission cycles
 * @route   GET /api/admin/payments/cycles
 * @access  Admin
 */
exports.getCommissionCycles = async (req, res) => {
  try {
    const cycles = await Commission.aggregate([
      {
        $group: {
          _id: '$commissionCycle.cycleNumber',
          month: { $first: '$commissionCycle.month' },
          year: { $first: '$commissionCycle.year' },
          totalCommission: { $sum: '$platformCommission' },
          totalEarnings: { $sum: '$professionalEarning' },
          totalConsultations: { $sum: 1 },
          paidAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
          },
          pendingAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
          }
        }
      },
      { $sort: { '_id': -1 } }
    ]);
    
    // Get payout history for each cycle
    for (const cycle of cycles) {
      const payouts = await Payout.find({ cycleNumber: cycle._id })
        .select('payoutNumber totalAmount status paidAt paymentMethod')
        .sort({ createdAt: -1 });
      
      cycle.payouts = payouts;
    }
    
    res.json({
      success: true,
      cycles
    });
    
  } catch (error) {
    console.error('Get commission cycles error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission cycles'
    });
  }
};

/**
 * @desc    Get commission summary
 * @route   GET /api/admin/payments/summary
 * @access  Admin
 */
exports.getCommissionSummary = async (req, res) => {
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();
    const currentCycle = `${currentMonth.toString().padStart(2, '0')}${currentYear}`;
    
    // Current month summary
    const currentMonthSummary = await Commission.aggregate([
      {
        $match: {
          'commissionCycle.cycleNumber': currentCycle
        }
      },
      {
        $group: {
          _id: '$professionalType',
          totalCommission: { $sum: '$platformCommission' },
          totalEarnings: { $sum: '$professionalEarning' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Year-to-date summary
    const ytdSummary = await Commission.aggregate([
      {
        $match: {
          'commissionCycle.year': currentYear
        }
      },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: '$platformCommission' },
          totalEarnings: { $sum: '$professionalEarning' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Top professionals by commission
    const topProfessionals = await Commission.aggregate([
      {
        $match: {
          'commissionCycle.year': currentYear
        }
      },
      {
        $group: {
          _id: {
            professionalId: '$professionalId',
            professionalType: '$professionalType'
          },
          totalCommission: { $sum: '$platformCommission' },
          totalEarnings: { $sum: '$professionalEarning' },
          count: { $sum: 1 }
        }
      },
      { $sort: { totalCommission: -1 } },
      { $limit: 10 }
    ]);
    
    // Get professional details for top professionals
    for (const professional of topProfessionals) {
      let profile;
      if (professional._id.professionalType === 'doctor') {
        profile = await DoctorProfile.findById(professional._id.professionalId)
          .select('name specialization');
      } else if (professional._id.professionalType === 'physio') {
        profile = await PhysiotherapistProfile.findById(professional._id.professionalId)
          .select('name services');
      } else if (professional._id.professionalType === 'pathology') {
        profile = await PathologyProfile.findById(professional._id.professionalId)
          .select('labName');
      }
      professional.professional = profile;
    }
    
    // Pending payout amount
    const pendingPayout = await Commission.aggregate([
      {
        $match: {
          payoutStatus: 'pending'
        }
      },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$platformCommission' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      summary: {
        currentMonth: currentMonthSummary,
        yearToDate: ytdSummary[0] || { totalCommission: 0, totalEarnings: 0, count: 0 },
        pendingPayout: pendingPayout[0] || { totalAmount: 0, count: 0 },
        topProfessionals,
        currentCycle
      }
    });
    
  } catch (error) {
    console.error('Get commission summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission summary'
    });
  }
};

/**
 * @desc    Process payout
 * @route   POST /api/admin/payments/payout
 * @access  Admin
 */
exports.processPayout = async (req, res) => {
  try {
    const { commissionIds, payoutMethod, notes, cycleNumber } = req.body;
    
    if (!commissionIds || !commissionIds.length) {
      return res.status(400).json({
        success: false,
        error: 'Commission IDs are required'
      });
    }
    
    if (!payoutMethod) {
      return res.status(400).json({
        success: false,
        error: 'Payout method is required'
      });
    }
    
    // Get commissions
    const commissions = await Commission.find({
      _id: { $in: commissionIds },
      payoutStatus: { $in: ['pending', 'processing'] }
    });
    
    if (commissions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No pending commissions found'
      });
    }
    
    // Check if all commissions belong to the same cycle
    const uniqueCycles = [...new Set(commissions.map(c => c.commissionCycle?.cycleNumber))];
    if (uniqueCycles.length > 1) {
      return res.status(400).json({
        success: false,
        error: 'Commissions must be from the same cycle for payout'
      });
    }
    
    const targetCycle = cycleNumber || uniqueCycles[0];
    
    // Calculate total amount
    const totalAmount = commissions.reduce((sum, c) => sum + (c.platformCommission || 0), 0);
    
    // Group commissions by professional
    const commissionsByProfessional = {};
    commissions.forEach(commission => {
      const key = `${commission.professionalType}_${commission.professionalId}`;
      if (!commissionsByProfessional[key]) {
        commissionsByProfessional[key] = {
          professionalType: commission.professionalType,
          professionalId: commission.professionalId,
          commissions: [],
          totalAmount: 0
        };
      }
      commissionsByProfessional[key].commissions.push(commission._id);
      commissionsByProfessional[key].totalAmount += commission.platformCommission || 0;
    });
    
    // Generate payout number
    const payoutCount = await Payout.countDocuments();
    const payoutNumber = `PAY${(payoutCount + 1).toString().padStart(6, '0')}`;
    
    // Create payout record
    const payout = await Payout.create({
      payoutNumber,
      cycleNumber: targetCycle,
      totalAmount,
      commissionIds,
      commissionsByProfessional: Object.values(commissionsByProfessional),
      payoutMethod,
      payoutDate: new Date(),
      status: 'processing',
      processedBy: req.user.id,
      notes: notes || ''
    });
    
    // Update commissions status to processing
    await Commission.updateMany(
      { _id: { $in: commissionIds } },
      {
        payoutStatus: 'processing',
        payoutId: payout._id,
        processingStartedAt: new Date()
      }
    );
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'PAYOUT_PROCESSED',
      entity: 'Payout',
      entityId: payout._id,
      details: {
        commissionIds,
        totalAmount,
        payoutMethod,
        notes,
        count: commissions.length,
        payoutNumber
      },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: `Payout ${payoutNumber} created for processing`,
      payout,
      summary: {
        totalAmount,
        commissionCount: commissions.length,
        professionalCount: Object.keys(commissionsByProfessional).length,
        cycle: targetCycle
      }
    });
    
  } catch (error) {
    console.error('Process payout error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process payout'
    });
  }
};

/**
 * @desc    Generate payout report
 * @route   POST /api/admin/payments/payout/generate-report
 * @access  Admin
 */
exports.generatePayoutReport = async (req, res) => {
  try {
    const { cycleNumber, professionalType, generateForAll = false } = req.body;
    
    if (!cycleNumber && !generateForAll) {
      return res.status(400).json({
        success: false,
        error: 'Cycle number is required or set generateForAll to true'
      });
    }
    
    let matchStage = { payoutStatus: 'pending' };
    
    if (!generateForAll) {
      matchStage['commissionCycle.cycleNumber'] = cycleNumber;
    }
    
    if (professionalType) {
      matchStage.professionalType = professionalType;
    }
    
    // Get commissions pending payout
    const commissions = await Commission.find(matchStage)
      .populate({
        path: 'professionalId',
        select: 'name labName bankDetails'
      })
      .populate('appointmentId', 'appointmentDate')
      .sort({ 'commissionCycle.cycleNumber': 1, professionalType: 1 });
    
    if (commissions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No pending commissions found for the specified criteria'
      });
    }
    
    // Group by cycle and professional
    const report = {};
    commissions.forEach(commission => {
      const cycle = commission.commissionCycle?.cycleNumber || 'N/A';
      const professionalKey = `${commission.professionalType}_${commission.professionalId?._id}`;
      
      if (!report[cycle]) {
        report[cycle] = {};
      }
      
      if (!report[cycle][professionalKey]) {
        report[cycle][professionalKey] = {
          professionalType: commission.professionalType,
          professionalId: commission.professionalId?._id,
          professionalName: commission.professionalId?.name || commission.professionalId?.labName || 'Unknown',
          commissions: [],
          totalAmount: 0,
          commissionCount: 0
        };
      }
      
      report[cycle][professionalKey].commissions.push({
        id: commission._id,
        appointmentDate: commission.appointmentId?.appointmentDate,
        consultationFee: commission.consultationFee,
        commissionAmount: commission.platformCommission,
        professionalEarning: commission.professionalEarning,
        createdAt: commission.createdAt
      });
      
      report[cycle][professionalKey].totalAmount += commission.platformCommission || 0;
      report[cycle][professionalKey].commissionCount += 1;
    });
    
    // Convert to array format
    const reportArray = [];
    for (const cycle in report) {
      for (const professionalKey in report[cycle]) {
        const professionalData = report[cycle][professionalKey];
        
        // Get payout threshold from settings
        const settings = await CommissionSettings.findOne();
        const payoutThreshold = settings?.payoutThreshold || 1000;
        
        reportArray.push({
          cycle,
          ...professionalData,
          eligibleForPayout: professionalData.totalAmount >= payoutThreshold
        });
      }
    }
    
    // Calculate totals
    const totals = {
      totalCycles: Object.keys(report).length,
      totalProfessionals: reportArray.length,
      totalCommissionAmount: reportArray.reduce((sum, item) => sum + item.totalAmount, 0),
      eligibleForPayout: reportArray.filter(item => item.eligibleForPayout).length,
      totalEligibleAmount: reportArray
        .filter(item => item.eligibleForPayout)
        .reduce((sum, item) => sum + item.totalAmount, 0)
    };
    
    res.json({
      success: true,
      report: reportArray,
      totals,
      generatedAt: new Date()
    });
    
  } catch (error) {
    console.error('Generate payout report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate payout report'
    });
  }
};

/**
 * @desc    Mark payout as paid
 * @route   POST /api/admin/payments/payout/:payoutId/mark-paid
 * @access  Admin
 */
exports.markPayoutAsPaid = async (req, res) => {
  try {
    const { payoutId } = req.params;
    const { transactionId, paymentDate, notes } = req.body;
    
    const payout = await Payout.findById(payoutId);
    if (!payout) {
      return res.status(404).json({
        success: false,
        error: 'Payout not found'
      });
    }
    
    if (payout.status === 'paid') {
      return res.status(400).json({
        success: false,
        error: 'Payout is already marked as paid'
      });
    }
    
    if (payout.status !== 'processing') {
      return res.status(400).json({
        success: false,
        error: 'Payout must be in processing status'
      });
    }
    
    // Update commissions to paid status
    await Commission.updateMany(
      { _id: { $in: payout.commissionIds } },
      {
        payoutStatus: 'paid',
        paidAt: paymentDate ? new Date(paymentDate) : new Date(),
        transactionId: transactionId || null,
        payoutNotes: notes || ''
      }
    );
    
    // Update professional pending commission
    for (const professionalData of payout.commissionsByProfessional) {
      await updateProfessionalCommissionAfterPayout(
        professionalData.professionalType,
        professionalData.professionalId,
        professionalData.totalAmount
      );
    }
    
    // Update payout record
    payout.status = 'paid';
    payout.paidAt = paymentDate ? new Date(paymentDate) : new Date();
    payout.transactionId = transactionId;
    payout.paidBy = req.user.id;
    payout.paymentDate = new Date();
    payout.notes = notes || payout.notes;
    
    await payout.save();
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'PAYOUT_MARKED_PAID',
      entity: 'Payout',
      entityId: payout._id,
      details: {
        payoutNumber: payout.payoutNumber,
        totalAmount: payout.totalAmount,
        transactionId,
        notes
      },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: `Payout ${payout.payoutNumber} marked as paid`,
      payout
    });
    
  } catch (error) {
    console.error('Mark payout as paid error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark payout as paid'
    });
  }
};

// ========== COMMISSION SETTINGS ==========

/**
 * @desc    Get commission settings
 * @route   GET /api/admin/commission-settings
 * @access  Admin
 */
exports.getCommissionSettings = async (req, res) => {
  try {
    const settings = await CommissionSettings.getSettings();
    
    res.json({
      success: true,
      settings
    });
    
  } catch (error) {
    console.error('Get commission settings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission settings'
    });
  }
};

/**
 * @desc    Update commission settings
 * @route   PUT /api/admin/commission-settings
 * @access  Admin
 */
exports.updateCommissionSettings = async (req, res) => {
  try {
    const settings = await CommissionSettings.getSettings();
    
    // Update allowed fields
    const allowedFields = [
      'defaultDoctorCommission',
      'defaultPhysioCommission',
      'defaultPathologyCommission',
      'payoutThreshold',
      'payoutSchedule',
      'taxRate',
      'minimumPayoutAmount',
      'maxPayoutWithoutVerification'
    ];
    
    Object.keys(req.body).forEach(key => {
      if (allowedFields.includes(key) && settings[key] !== undefined) {
        settings[key] = req.body[key];
      }
    });
    
    settings.updatedBy = req.user.id;
    settings.updatedAt = new Date();
    settings.version += 1;
    
    await settings.save();
    
    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'COMMISSION_SETTINGS_UPDATED',
      entity: 'CommissionSettings',
      details: { updatedFields: Object.keys(req.body) },
      timestamp: new Date()
    });
    
    res.json({
      success: true,
      message: 'Commission settings updated successfully',
      settings
    });
    
  } catch (error) {
    console.error('Update commission settings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update commission settings'
    });
  }
};

// ========== VERIFICATIONS ==========

/**
 * @desc    Get pending verifications
 * @route   GET /api/admin/verifications
 * @access  Admin
 */
exports.getPendingVerifications = async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    
    const filter = { verificationStatus: 'pending' };
    
    let results = {};
    
    if (!type || type === 'doctor') {
      const doctors = await DoctorProfile.find(filter)
        .populate('userId', 'email phone createdAt')
        .select('name specialization licenseNumber qualifications experienceYears clinicAddress')
        .sort({ createdAt: 1 })
        .limit(type ? parseInt(limit) : 100);
      
      results.doctors = doctors;
    }
    
    if (!type || type === 'physio') {
      const physios = await PhysiotherapistProfile.find(filter)
        .populate('userId', 'email phone createdAt')
        .select('name specialization licenseNumber qualifications experienceYears clinicAddress')
        .sort({ createdAt: 1 })
        .limit(type ? parseInt(limit) : 100);
      
      results.physios = physios;
    }
    
    if (!type || type === 'pathology') {
      const pathology = await PathologyProfile.find(filter)
        .populate('userId', 'email phone createdAt')
        .select('labName registrationNumber services address licenses')
        .sort({ createdAt: 1 })
        .limit(type ? parseInt(limit) : 100);
      
      results.pathology = pathology;
    }
    
    res.json({
      success: true,
      verifications: results
    });
    
  } catch (error) {
    console.error('Get pending verifications error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch verifications'
    });
  }
};

/**
 * @desc    Get verification statistics
 * @route   GET /api/admin/verifications/stats
 * @access  Admin
 */
exports.getVerificationStats = async (req, res) => {
  try {
    const [doctors, physios, pathology] = await Promise.all([
      DoctorProfile.aggregate([
        {
          $group: {
            _id: '$verificationStatus',
            count: { $sum: 1 }
          }
        }
      ]),
      PhysiotherapistProfile.aggregate([
        {
          $group: {
            _id: '$verificationStatus',
            count: { $sum: 1 }
          }
        }
      ]),
      PathologyProfile.aggregate([
        {
          $group: {
            _id: '$verificationStatus',
            count: { $sum: 1 }
          }
        }
      ])
    ]);
    
    const formatStats = (data) => {
      return {
        pending: data.find(d => d._id === 'pending')?.count || 0,
        approved: data.find(d => d._id === 'approved')?.count || 0,
        rejected: data.find(d => d._id === 'rejected')?.count || 0
      };
    };
    
    res.json({
      success: true,
      stats: {
        doctors: formatStats(doctors),
        physios: formatStats(physios),
        pathology: formatStats(pathology)
      }
    });
    
  } catch (error) {
    console.error('Get verification stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch verification statistics'
    });
  }
};

// ========== PATHOLOGY MANAGEMENT ==========

/**
 * @desc    Get all pathology labs
 * @route   GET /api/admin/pathology
 * @access  Admin
 */
exports.getPathologyLabs = async (req, res) => {
  try {
    const {
      verificationStatus,
      search,
      page = 1,
      limit = 20
    } = req.query;
    
    const filter = {};
    if (verificationStatus) filter.verificationStatus = verificationStatus;
    
    if (search) {
      filter.$or = [
        { labName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const labs = await PathologyProfile.find(filter)
      .populate('userId', 'email isActive')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await PathologyProfile.countDocuments(filter);
    
    res.json({
      success: true,
      labs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get pathology labs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pathology labs'
    });
  }
};

/**
 * @desc    Get pathology lab by ID
 * @route   GET /api/admin/pathology/:id
 * @access  Admin
 */
exports.getPathologyById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const lab = await PathologyProfile.findById(id)
      .populate('userId', 'email isActive lastLogin');
    
    if (!lab) {
      return res.status(404).json({
        success: false,
        error: 'Pathology lab not found'
      });
    }
    
    // Get recent tests
    const recentTests = await LabTest.find({ pathologyId: id })
      .populate('patientId', 'name')
      .sort({ scheduledDate: -1 })
      .limit(10);
    
    // Get statistics
    const stats = await LabTest.aggregate([
      { $match: { pathologyId: lab._id } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          revenue: { $sum: '$totalAmount' }
        }
      }
    ]);
    
    res.json({
      success: true,
      lab,
      recentTests,
      stats: stats.reduce((acc, curr) => {
        acc[curr._id] = { count: curr.count, revenue: curr.revenue };
        return acc;
      }, {})
    });
    
  } catch (error) {
    console.error('Get pathology by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pathology lab details'
    });
  }
};

/**
 * @desc    Update pathology lab
 * @route   PUT /api/admin/pathology/:id
 * @access  Admin
 */
exports.updatePathologyLab = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Remove protected fields
    delete updates.userId;
    delete updates.verificationStatus;
    delete updates.verifiedAt;
    delete updates.verifiedBy;
    
    const lab = await PathologyProfile.findByIdAndUpdate(
      id,
      updates,
      { new: true, runValidators: true }
    );
    
    if (!lab) {
      return res.status(404).json({
        success: false,
        error: 'Pathology lab not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Pathology lab updated successfully',
      lab
    });
    
  } catch (error) {
    console.error('Update pathology lab error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update pathology lab'
    });
  }
};

/**
 * @desc    Delete pathology lab
 * @route   DELETE /api/admin/pathology/:id
 * @access  Admin
 */
exports.deletePathologyLab = async (req, res) => {
  try {
    const { id } = req.params;
    
    const lab = await PathologyProfile.findById(id);
    if (!lab) {
      return res.status(404).json({
        success: false,
        error: 'Pathology lab not found'
      });
    }
    
    // Check for active tests
    const activeTests = await LabTest.countDocuments({
      pathologyId: id,
      status: { $in: ['requested', 'scheduled', 'processing'] }
    });
    
    if (activeTests > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete lab with active tests. Cancel tests first.'
      });
    }
    
    // Soft delete - mark as inactive
    await PathologyProfile.findByIdAndUpdate(id, { isActive: false });
    
    // Update user
    await User.findByIdAndUpdate(lab.userId, { isActive: false });
    
    res.json({
      success: true,
      message: 'Pathology lab deactivated successfully'
    });
    
  } catch (error) {
    console.error('Delete pathology lab error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete pathology lab'
    });
  }
};

// ========== PHARMACY MANAGEMENT ==========

/**
 * @desc    Get all pharmacies
 * @route   GET /api/admin/pharmacy
 * @access  Admin
 */
exports.getPharmacies = async (req, res) => {
  try {
    const {
      status,
      search,
      page = 1,
      limit = 20
    } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const pharmacies = await Pharmacy.find(filter)
      .populate('userId', 'email isActive')
      .sort({ registeredAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Pharmacy.countDocuments(filter);
    
    res.json({
      success: true,
      pharmacies,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get pharmacies error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pharmacies'
    });
  }
};

/**
 * @desc    Get pharmacy by ID
 * @route   GET /api/admin/pharmacy/:id
 * @access  Admin
 */
exports.getPharmacyById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const pharmacy = await Pharmacy.findById(id)
      .populate('userId', 'email isActive lastLogin');
    
    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }
    
    // Get recent sales
    const recentSales = await PharmacySale.find({ pharmacyId: id })
      .populate('patientId', 'name')
      .sort({ saleDate: -1 })
      .limit(10);
    
    // Get inventory stats
    const inventoryStats = await Medicine.aggregate([
      { $match: { pharmacyId: id, isActive: true } },
      {
        $group: {
          _id: null,
          totalMedicines: { $sum: 1 },
          lowStockCount: {
            $sum: { $cond: [{ $lte: ['$quantity', { $ifNull: ['$reorderLevel', 10] }] }, 1, 0] }
          },
          totalValue: { $sum: { $multiply: ['$quantity', '$purchasePrice'] } }
        }
      }
    ]);
    
    res.json({
      success: true,
      pharmacy,
      recentSales,
      inventoryStats: inventoryStats[0] || { totalMedicines: 0, lowStockCount: 0, totalValue: 0 }
    });
    
  } catch (error) {
    console.error('Get pharmacy by ID error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pharmacy details'
    });
  }
};

/**
 * @desc    Update pharmacy
 * @route   PUT /api/admin/pharmacy/:id
 * @access  Admin
 */
exports.updatePharmacy = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const pharmacy = await Pharmacy.findByIdAndUpdate(
      id,
      updates,
      { new: true, runValidators: true }
    );
    
    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Pharmacy updated successfully',
      pharmacy
    });
    
  } catch (error) {
    console.error('Update pharmacy error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update pharmacy'
    });
  }
};

/**
 * @desc    Delete pharmacy
 * @route   DELETE /api/admin/pharmacy/:id
 * @access  Admin
 */
exports.deletePharmacy = async (req, res) => {
  try {
    const { id } = req.params;
    
    const pharmacy = await Pharmacy.findById(id);
    if (!pharmacy) {
      return res.status(404).json({
        success: false,
        error: 'Pharmacy not found'
      });
    }
    
    // Soft delete - mark as inactive
    await Pharmacy.findByIdAndUpdate(id, { status: 'Inactive' });
    
    // Update user
    await User.findByIdAndUpdate(pharmacy.userId, { isActive: false });
    
    res.json({
      success: true,
      message: 'Pharmacy deactivated successfully'
    });
    
  } catch (error) {
    console.error('Delete pharmacy error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete pharmacy'
    });
  }
};

// ========== SYSTEM & AUDIT ==========

/**
 * @desc    Get audit logs
 * @route   GET /api/admin/audit-logs
 * @access  Admin
 */
exports.getAuditLogs = async (req, res) => {
  try {
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
    if (action) filter.action = { $regex: action, $options: 'i' };
    if (entity) filter.entity = entity;
    if (startDate && endDate) {
      filter.timestamp = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const logs = await AuditLog.find(filter)
      .populate('userId', 'name email role')
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await AuditLog.countDocuments(filter);
    
    // Get summary by action type
    const summary = await AuditLog.aggregate([
      { $match: filter },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({
      success: true,
      logs,
      summary,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
    
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch audit logs'
    });
  }
};

/**
 * @desc    Get system metrics
 * @route   GET /api/admin/system-metrics
 * @access  Admin
 */
exports.getSystemMetrics = async (req, res) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const [
      activeUsers24h,
      apiCalls24h,
      errorCount24h,
      dbStats
    ] = await Promise.all([
      // Active users in last 24h
      User.countDocuments({ lastLogin: { $gte: oneDayAgo } }),
      
      // API calls in last 24h (from audit logs)
      AuditLog.countDocuments({ timestamp: { $gte: oneDayAgo } }),
      
      // Error logs
      AuditLog.countDocuments({ 
        timestamp: { $gte: oneDayAgo },
        action: { $regex: 'ERROR|FAILED', $options: 'i' }
      }),
      
      // Database stats
      mongoose.connection.db.stats()
    ]);
    
    // Calculate health score
    const errorRate = apiCalls24h > 0 ? (errorCount24h / apiCalls24h) * 100 : 0;
    const healthScore = Math.max(0, 100 - errorRate - (apiCalls24h < 100 ? 10 : 0));
    
    res.json({
      success: true,
      metrics: {
        activeUsers24h,
        apiCalls24h,
        errorCount24h,
        errorRate: errorRate.toFixed(2),
        healthScore: Math.min(100, healthScore).toFixed(1),
        dbSize: formatBytes(dbStats.dataSize),
        collections: dbStats.collections,
        timestamp: now
      }
    });
    
  } catch (error) {
    console.error('Get system metrics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch system metrics'
    });
  }
};

/**
 * @desc    Export report
 * @route   GET /api/admin/export/report
 * @access  Admin
 */
exports.exportReport = async (req, res) => {
  try {
    const { type, startDate, endDate, format = 'json' } = req.query;
    
    let data = [];
    const dateRange = {
      $gte: startDate ? new Date(startDate) : new Date(new Date().setDate(new Date().getDate() - 30)),
      $lte: endDate ? new Date(endDate) : new Date()
    };
    
    switch(type) {
      case 'users':
        data = await User.find({ createdAt: dateRange })
          .select('-password -resetPasswordToken -resetPasswordExpire -emailVerificationToken -emailVerificationExpires')
          .lean();
        break;
      case 'appointments':
        data = await Appointment.find({ createdAt: dateRange })
          .populate('patientId', 'name')
          .populate('doctorId', 'name')
          .populate('physioId', 'name')
          .lean();
        break;
      case 'payments':
        data = await Commission.find({ createdAt: dateRange })
          .populate('professionalId')
          .populate('appointmentId')
          .lean();
        break;
      case 'audit':
        data = await AuditLog.find({ timestamp: dateRange })
          .populate('userId', 'name email')
          .lean();
        break;
      default:
        return res.status(400).json({
          success: false,
          error: 'Invalid report type'
        });
    }
    
    if (format === 'csv') {
      // Convert to CSV
      const csv = convertToCSV(data);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${type}-report-${new Date().toISOString().split('T')[0]}.csv`);
      return res.send(csv);
    }
    
    res.json({
      success: true,
      data,
      count: data.length,
      dateRange
    });
    
  } catch (error) {
    console.error('Export report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export report'
    });
  }
};

// ========== HELPER FUNCTIONS ==========

function buildFilter({ verificationStatus, specialization, search }) {
  const filter = {};
  
  if (verificationStatus) filter.verificationStatus = verificationStatus;
  if (specialization) filter.specialization = { $in: [specialization] };
  
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { labName: { $regex: search, $options: 'i' } }
    ];
  }
  
  return filter;
}

async function checkSystemHealth() {
  try {
    const checks = {
      database: mongoose.connection.readyState === 1,
      api: true,
      storage: true,
      auth: true
    };
    
    const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length * 100;
    
    return {
      score,
      checks
    };
  } catch (error) {
    return {
      score: 50,
      checks: {
        database: false,
        api: true,
        storage: true,
        auth: true
      }
    };
  }
}

async function getWeeklyTrend() {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);
  
  const appointments = await Appointment.aggregate([
    {
      $match: {
        createdAt: { $gte: startOfWeek }
      }
    },
    {
      $group: {
        _id: { $dayOfWeek: '$createdAt' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id': 1 } }
  ]);
  
  const users = await User.aggregate([
    {
      $match: {
        createdAt: { $gte: startOfWeek }
      }
    },
    {
      $group: {
        _id: { $dayOfWeek: '$createdAt' },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id': 1 } }
  ]);
  
  return {
    appointments: appointments.map(d => d.count),
    users: users.map(d => d.count)
  };
}

async function getDoctorStats(doctorId) {
  if (!doctorId) return {};
  
  const [appointments, earnings, ratings] = await Promise.all([
    Appointment.countDocuments({ doctorId, professionalType: 'doctor' }),
    Commission.aggregate([
      { $match: { professionalId: doctorId, professionalType: 'doctor' } },
      { $group: { _id: null, total: { $sum: '$professionalEarning' } } }
    ]),
    Appointment.aggregate([
      { $match: { doctorId, professionalType: 'doctor', rating: { $exists: true } } },
      { $group: { _id: null, avg: { $avg: '$rating' } } }
    ])
  ]);
  
  return {
    totalAppointments: appointments,
    totalEarnings: earnings[0]?.total || 0,
    averageRating: ratings[0]?.avg || 0
  };
}

async function getPhysioStats(physioId) {
  if (!physioId) return {};
  
  const [appointments, earnings, ratings] = await Promise.all([
    Appointment.countDocuments({ physioId, professionalType: 'physio' }),
    Commission.aggregate([
      { $match: { professionalId: physioId, professionalType: 'physio' } },
      { $group: { _id: null, total: { $sum: '$professionalEarning' } } }
    ]),
    Appointment.aggregate([
      { $match: { physioId, professionalType: 'physio', rating: { $exists: true } } },
      { $group: { _id: null, avg: { $avg: '$rating' } } }
    ])
  ]);
  
  return {
    totalAppointments: appointments,
    totalEarnings: earnings[0]?.total || 0,
    averageRating: ratings[0]?.avg || 0
  };
}

async function getPatientStats(patientId) {
  if (!patientId) return {};
  
  const [appointments, prescriptions, labTests] = await Promise.all([
    Appointment.countDocuments({ patientId }),
    require('../models/Prescription').countDocuments({ patientId }),
    require('../models/LabTest').countDocuments({ patientId })
  ]);
  
  return {
    totalAppointments: appointments,
    totalPrescriptions: prescriptions,
    totalLabTests: labTests
  };
}

async function getPathologyStats(pathologyId) {
  if (!pathologyId) return {};
  
  const [tests, revenue] = await Promise.all([
    require('../models/LabTest').countDocuments({ pathologyId }),
    require('../models/LabTest').aggregate([
      { $match: { pathologyId } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ])
  ]);
  
  return {
    totalTests: tests,
    totalRevenue: revenue[0]?.total || 0
  };
}

async function getPharmacyStats(pharmacyId) {
  if (!pharmacyId) return {};
  
  const [sales, medicines, revenue] = await Promise.all([
    require('../models/PharmacySale').countDocuments({ pharmacyId }),
    require('../models/Medicine').countDocuments({ pharmacyId }),
    require('../models/PharmacySale').aggregate([
      { $match: { pharmacyId, status: 'dispensed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ])
  ]);
  
  return {
    totalSales: sales,
    totalMedicines: medicines,
    totalRevenue: revenue[0]?.total || 0
  };
}

async function updateProfessionalCommissionAfterPayout(professionalType, professionalId, amount) {
  try {
    const updateFields = {
      $inc: {
        pendingCommission: -amount,
        paidCommission: amount
      }
    };
    
    if (professionalType === 'doctor') {
      await DoctorProfile.findByIdAndUpdate(professionalId, updateFields);
    } else if (professionalType === 'physio') {
      await PhysiotherapistProfile.findByIdAndUpdate(professionalId, updateFields);
    } else if (professionalType === 'pathology') {
      await PathologyProfile.findByIdAndUpdate(professionalId, updateFields);
    }
  } catch (error) {
    console.error('Error updating professional commission:', error);
  }
}

function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - new Date(date);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour ago`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

function formatActionText(action) {
  return action
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function convertToCSV(data) {
  if (!data || !data.length) return '';
  
  // Get headers from first object
  const headers = Object.keys(data[0]).filter(key => 
    !key.includes('password') && 
    !key.includes('token') && 
    !key.includes('secret')
  );
  
  const csvRows = [];
  
  // Add headers
  csvRows.push(headers.join(','));
  
  // Add rows
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      // Handle different value types
      if (value === null || value === undefined) return '';
      if (value instanceof Date) return `"${value.toISOString()}"`;
      if (typeof value === 'object') return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
      return `"${String(value).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }
  
  return csvRows.join('\n');
}

// Add these methods to your admin.controller.js

// ========== KPI ENDPOINTS ==========

/**
 * @desc    Get user KPIs
 * @route   GET /api/admin/kpis/users
 * @access  Admin
 */
exports.getUserKpis = async (req, res) => {
  try {
    const total = await User.countDocuments();
    const verified = await User.countDocuments({ isVerified: true });
    const active = await User.countDocuments({ isActive: true });
    const byRole = await User.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]);

    const roleDistribution = {};
    byRole.forEach(item => {
      roleDistribution[item._id] = item.count;
    });

    res.json({
      success: true,
      total,
      verified,
      active,
      byRole: roleDistribution,
      today: await User.countDocuments({
        createdAt: { $gte: new Date().setHours(0, 0, 0, 0) }
      })
    });
  } catch (err) {
    console.error('Error fetching user KPIs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get funnel KPIs
 * @route   GET /api/admin/kpis/funnel
 * @access  Admin
 */
exports.getFunnelKpis = async (req, res) => {
  try {
    const referrals = await Referral.countDocuments();
    const appointments = await Appointment.countDocuments();
    const prescriptions = await Prescription.countDocuments();
    const labTests = await LabTest.countDocuments();

    res.json({
      success: true,
      referrals,
      appointments,
      prescriptions,
      labTests
    });
  } catch (err) {
    console.error('Error fetching funnel KPIs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get appointment KPIs
 * @route   GET /api/admin/kpis/appointments
 * @access  Admin
 */
exports.getAppointmentKpis = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const matchStage = {};
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const total = await Appointment.countDocuments(matchStage);
    const completed = await Appointment.countDocuments({ ...matchStage, status: 'completed' });
    const cancelled = await Appointment.countDocuments({ ...matchStage, status: 'cancelled' });
    const pending = await Appointment.countDocuments({ 
      ...matchStage, 
      status: { $in: ['pending', 'confirmed', 'accepted'] } 
    });

    // Get daily trend
    const dailyTrend = await Appointment.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      { $limit: 30 }
    ]);

    res.json({
      success: true,
      total,
      completed,
      cancelled,
      pending,
      dailyTrend
    });
  } catch (err) {
    console.error('Error fetching appointment KPIs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get lab test KPIs
 * @route   GET /api/admin/kpis/labtests
 * @access  Admin
 */
exports.getLabTestKpis = async (req, res) => {
  try {
    const total = await LabTest.countDocuments();
    const completed = await LabTest.countDocuments({ status: 'completed' });
    const pending = await LabTest.countDocuments({ 
      status: { $in: ['requested', 'scheduled', 'processing'] } 
    });

    // Get tests by pathology lab
    const byLab = await LabTest.aggregate([
      {
        $group: {
          _id: '$pathologyId',
          count: { $sum: 1 },
          revenue: { $sum: '$totalAmount' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      success: true,
      total,
      completed,
      pending,
      byLab
    });
  } catch (err) {
    console.error('Error fetching lab test KPIs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get pharmacy KPIs
 * @route   GET /api/admin/kpis/pharmacy
 * @access  Admin
 */
exports.getPharmacyKpis = async (req, res) => {
  try {
    const totalMedicines = await Medicine.countDocuments({ isActive: true });
    const lowStock = await Medicine.countDocuments({
      quantity: { $lte: { $ifNull: ['$reorderLevel', 10] } }
    });
    const totalSales = await PharmacySale.countDocuments({ status: 'dispensed' });
    
    const revenue = await PharmacySale.aggregate([
      { $match: { status: 'dispensed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    res.json({
      success: true,
      totalMedicines,
      lowStock,
      totalSales,
      totalRevenue: revenue[0]?.total || 0
    });
  } catch (err) {
    console.error('Error fetching pharmacy KPIs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get revenue KPIs
 * @route   GET /api/admin/kpis/revenue
 * @access  Admin
 */
exports.getRevenueKpis = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const matchStage = {};
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    // Appointment revenue
    const appointmentRevenue = await Appointment.aggregate([
      { $match: { ...matchStage, paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$consultationFee' } } }
    ]);

    // Pharmacy revenue
    const pharmacyRevenue = await PharmacySale.aggregate([
      { $match: { ...matchStage, status: 'dispensed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    // Lab test revenue
    const labRevenue = await LabTest.aggregate([
      { $match: { ...matchStage, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);

    // Platform commission
    const commission = await Commission.aggregate([
      { $match: matchStage },
      { $group: { _id: null, total: { $sum: '$platformCommission' } } }
    ]);

    res.json({
      success: true,
      appointment: appointmentRevenue[0]?.total || 0,
      pharmacy: pharmacyRevenue[0]?.total || 0,
      labTests: labRevenue[0]?.total || 0,
      totalRevenue: (appointmentRevenue[0]?.total || 0) + 
                   (pharmacyRevenue[0]?.total || 0) + 
                   (labRevenue[0]?.total || 0),
      platformCommission: commission[0]?.total || 0
    });
  } catch (err) {
    console.error('Error fetching revenue KPIs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get top medicines KPI
 * @route   GET /api/admin/kpis/top-medicines
 * @access  Admin
 */
exports.getTopMedicinesKpi = async (req, res) => {
  try {
    const top = await PharmacySale.aggregate([
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.medicineId',
          medicineName: { $first: '$items.medicineName' },
          totalSold: { $sum: '$items.quantity' },
          totalRevenue: { $sum: { $multiply: ['$items.quantity', '$items.sellingPrice'] } }
        }
      },
      { $sort: { totalSold: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      success: true,
      top
    });
  } catch (err) {
    console.error('Error fetching top medicines:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ========== ANALYTICS ENDPOINTS ==========

/**
 * @desc    Get device analytics
 * @route   GET /api/admin/analytics/devices
 * @access  Admin
 */
exports.getDeviceAnalytics = async (req, res) => {
  try {
    // This would typically come from your analytics service
    // For now, return mock data
    res.json({
      success: true,
      data: [
        { device: 'Mobile', value: 75 },
        { device: 'Desktop', value: 20 },
        { device: 'Tablet', value: 5 }
      ]
    });
  } catch (err) {
    console.error('Error fetching device analytics:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get geographic analytics
 * @route   GET /api/admin/analytics/geographic
 * @access  Admin
 */
exports.getGeographicAnalytics = async (req, res) => {
  try {
    // Aggregate user locations from profiles
    const doctorLocations = await DoctorProfile.aggregate([
      {
        $group: {
          _id: '$clinicAddress.city',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const patientLocations = await PatientProfile.aggregate([
      {
        $group: {
          _id: '$address.city',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      success: true,
      data: [
        { city: 'Mumbai', users: 1200, revenue: 450000 },
        { city: 'Delhi', users: 950, revenue: 380000 },
        { city: 'Bangalore', users: 850, revenue: 320000 },
        { city: 'Chennai', users: 650, revenue: 280000 },
        { city: 'Kolkata', users: 500, revenue: 220000 }
      ],
      doctorLocations,
      patientLocations
    });
  } catch (err) {
    console.error('Error fetching geographic analytics:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get traffic analytics
 * @route   GET /api/admin/analytics/traffic
 * @access  Admin
 */
exports.getTrafficAnalytics = async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const traffic = await AuditLog.aggregate([
      {
        $match: {
          timestamp: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$timestamp' },
            month: { $month: '$timestamp' },
            day: { $dayOfMonth: '$timestamp' }
          },
          requests: { $sum: 1 },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          date: {
            $dateFromParts: {
              year: '$_id.year',
              month: '$_id.month',
              day: '$_id.day'
            }
          },
          requests: 1,
          uniqueUsers: { $size: '$uniqueUsers' }
        }
      },
      { $sort: { date: 1 } }
    ]);

    res.json({
      success: true,
      traffic
    });
  } catch (err) {
    console.error('Error fetching traffic analytics:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get performance analytics
 * @route   GET /api/admin/analytics/performance
 * @access  Admin
 */
exports.getPerformanceAnalytics = async (req, res) => {
  try {
    const avgResponseTime = await AuditLog.aggregate([
      {
        $match: {
          duration: { $exists: true }
        }
      },
      {
        $group: {
          _id: null,
          avg: { $avg: '$duration' },
          min: { $min: '$duration' },
          max: { $max: '$duration' }
        }
      }
    ]);

    const errorRate = await AuditLog.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          errors: {
            $sum: {
              $cond: [
                { $or: [
                  { $gte: ['$statusCode', 400] },
                  { $ne: ['$errorMessage', null] }
                ]},
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    res.json({
      success: true,
      avgResponseTime: avgResponseTime[0]?.avg || 0,
      minResponseTime: avgResponseTime[0]?.min || 0,
      maxResponseTime: avgResponseTime[0]?.max || 0,
      errorRate: errorRate[0] ? (errorRate[0].errors / errorRate[0].total * 100).toFixed(2) : 0
    });
  } catch (err) {
    console.error('Error fetching performance analytics:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ========== REPORTS MANAGEMENT ==========

/**
 * @desc    Get all reports
 * @route   GET /api/admin/reports
 * @access  Admin
 */
exports.getReports = async (req, res) => {
  try {
    // This would typically come from a Reports collection
    // For now, generate reports from existing data
    const reports = [];

    // Generate reports from different data sources
    const now = new Date();
    
    // Add financial report
    reports.push({
      _id: `report_${Date.now()}_1`,
      type: 'financial',
      name: 'Financial Report',
      timeRange: 'month',
      format: 'pdf',
      status: 'completed',
      generatedAt: now.toISOString(),
      generatedBy: req.user.name || 'Admin',
      fileSize: 1500000,
      pageCount: 12,
      description: 'Monthly financial summary including revenue, commissions, and payouts'
    });

    // Add user report
    reports.push({
      _id: `report_${Date.now()}_2`,
      type: 'user',
      name: 'User Analytics',
      timeRange: 'month',
      format: 'excel',
      status: 'completed',
      generatedAt: new Date(now.setDate(now.getDate() - 2)).toISOString(),
      generatedBy: 'System',
      fileSize: 850000,
      pageCount: 8,
      description: 'User growth, roles distribution, and activity metrics'
    });

    // Add appointment report
    reports.push({
      _id: `report_${Date.now()}_3`,
      type: 'appointment',
      name: 'Appointment Report',
      timeRange: 'month',
      format: 'csv',
      status: 'completed',
      generatedAt: new Date(now.setDate(now.getDate() - 5)).toISOString(),
      generatedBy: 'System',
      fileSize: 1200000,
      pageCount: 15,
      description: 'Appointment trends, completion rates, and professional performance'
    });

    res.json({
      success: true,
      reports
    });
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Generate a new report
 * @route   POST /api/admin/reports/generate
 * @access  Admin
 */
exports.generateReport = async (req, res) => {
  try {
    const { type, timeRange, format, includeCharts, includeDetails, emailReport } = req.body;

    // This would trigger report generation job
    // For now, return a mock report
    const report = {
      _id: `report_${Date.now()}`,
      type,
      name: reportTypes.find(r => r.id === type)?.name || 'Report',
      timeRange,
      format,
      status: 'completed',
      generatedAt: new Date().toISOString(),
      generatedBy: req.user.name || 'Admin',
      fileSize: 2000000,
      pageCount: 10,
      description: `${type} report generated for ${timeRange}`,
      downloadUrl: `/api/admin/export/report?type=${type}&format=${format}`
    };

    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'REPORT_GENERATED',
      entity: 'Report',
      details: { type, timeRange, format },
      timestamp: new Date()
    });

    res.json({
      success: true,
      report
    });
  } catch (err) {
    console.error('Error generating report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Get scheduled reports
 * @route   GET /api/admin/reports/scheduled
 * @access  Admin
 */
exports.getScheduledReports = async (req, res) => {
  try {
    // This would come from a ScheduledReports collection
    // For now, return mock data
    const schedules = [
      {
        id: 'schedule_1',
        reportType: 'financial',
        frequency: 'monthly',
        dayOfMonth: 1,
        time: '09:00',
        format: 'pdf',
        includeCharts: true,
        includeDetails: true,
        nextRun: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1, 9, 0, 0).toISOString(),
        recipients: ['admin@example.com']
      },
      {
        id: 'schedule_2',
        reportType: 'user',
        frequency: 'weekly',
        dayOfWeek: 'monday',
        time: '10:00',
        format: 'excel',
        includeCharts: false,
        includeDetails: true,
        nextRun: new Date(new Date().setDate(new Date().getDate() + (8 - new Date().getDay()))).toISOString(),
        recipients: ['admin@example.com']
      }
    ];

    res.json({
      success: true,
      schedules
    });
  } catch (err) {
    console.error('Error fetching scheduled reports:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Schedule a report
 * @route   POST /api/admin/reports/schedule
 * @access  Admin
 */
exports.scheduleReport = async (req, res) => {
  try {
    const { reportType, frequency, dayOfMonth, dayOfWeek, time, format, includeCharts, includeDetails, recipients } = req.body;

    // Calculate next run date
    const nextRun = calculateNextRun({ frequency, dayOfMonth, dayOfWeek, time });

    const schedule = {
      id: `schedule_${Date.now()}`,
      reportType,
      frequency,
      dayOfMonth,
      dayOfWeek,
      time,
      format,
      includeCharts,
      includeDetails,
      recipients,
      nextRun: nextRun.toISOString(),
      createdAt: new Date().toISOString(),
      createdBy: req.user.id
    };

    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'REPORT_SCHEDULED',
      entity: 'ReportSchedule',
      details: { reportType, frequency, time },
      timestamp: new Date()
    });

    res.json({
      success: true,
      schedule
    });
  } catch (err) {
    console.error('Error scheduling report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Delete a scheduled report
 * @route   DELETE /api/admin/reports/schedule/:id
 * @access  Admin
 */
exports.deleteScheduledReport = async (req, res) => {
  try {
    const { id } = req.params;

    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'SCHEDULED_REPORT_DELETED',
      entity: 'ReportSchedule',
      entityId: id,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: 'Scheduled report deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting scheduled report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Delete a report
 * @route   DELETE /api/admin/reports/:id
 * @access  Admin
 */
exports.deleteReport = async (req, res) => {
  try {
    const { id } = req.params;

    // Log the action
    await AuditLog.create({
      userId: req.user.id,
      action: 'REPORT_DELETED',
      entity: 'Report',
      entityId: id,
      timestamp: new Date()
    });

    res.json({
      success: true,
      message: 'Report deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * @desc    Clear audit logs
 * @route   DELETE /api/admin/audit-logs/clear
 * @access  Admin
 */
exports.clearAuditLogs = async (req, res) => {
  try {
    const { olderThanDays = 30 } = req.body;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await AuditLog.deleteMany({
      timestamp: { $lt: cutoffDate }
    });

    res.json({
      success: true,
      message: `Cleared ${result.deletedCount} audit logs older than ${olderThanDays} days`
    });
  } catch (err) {
    console.error('Error clearing audit logs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Helper function to calculate next run date
function calculateNextRun({ frequency, dayOfMonth, dayOfWeek, time }) {
  const now = new Date();
  const [hours, minutes] = time.split(':').map(Number);
  
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  switch(frequency) {
    case 'daily':
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      break;
    case 'weekly':
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(dayOfWeek);
      const currentDay = next.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0 || (daysToAdd === 0 && next <= now)) {
        daysToAdd += 7;
      }
      next.setDate(next.getDate() + daysToAdd);
      break;
    case 'monthly':
      next.setDate(dayOfMonth);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
  }

  return next;
}