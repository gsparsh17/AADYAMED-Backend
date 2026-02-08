const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const Appointment = require('../models/Appointment');
const Payout = require('../models/Payout');

const mongoose = require('mongoose');

function normalizeRole(role) {
  const r = (role || '').toLowerCase().trim();
  if (r === 'physio') return 'physiotherapist';
  return r;
}

function normalizeProfessionalType(t) {
  const x = (t || '').toLowerCase().trim();
  if (x === 'physio') return 'physiotherapist';
  return x;
}

function mapUserRoleToProfessionalType(userRole) {
  const r = normalizeRole(userRole);
  const roleMap = {
    doctor: 'doctor',
    physiotherapist: 'physiotherapist',
    pathology: 'pathology'
  };
  return roleMap[r] || r;
}

async function getProfessionalProfileId(user) {
  try {
    const role = normalizeRole(user.role);
    let profile = null;

    if (role === 'doctor') {
      profile = await DoctorProfile.findOne({ userId: user.id }).select('_id');
    } else if (role === 'physiotherapist') {
      profile = await PhysiotherapistProfile.findOne({ userId: user.id }).select('_id');
    } else if (role === 'pathology') {
      profile = await PathologyProfile.findOne({ userId: user.id }).select('_id');
    }

    return profile ? profile._id : null;
  } catch (error) {
    console.error('Error getting professional profile ID:', error);
    return null;
  }
}

// Get commissions (role-based)
exports.getCommissions = async (req, res) => {
  try {
    const {
      professionalId,
      professionalType,
      payoutStatus,
      cycle,
      startDate,
      endDate,
      page = 1,
      limit = 20
    } = req.query;

    const filter = {};
    const normalizedRole = normalizeRole(req.user.role);

    // ---- role based scope ----
    if (normalizedRole === 'admin') {
      if (professionalId) {
        if (!mongoose.Types.ObjectId.isValid(professionalId)) {
          return res.status(400).json({ success: false, error: 'Invalid professionalId' });
        }
        filter.professionalId = professionalId;
      }
      if (professionalType) filter.professionalType = normalizeProfessionalType(professionalType);
    } else if (['doctor', 'physiotherapist', 'pathology'].includes(normalizedRole)) {
      const profileId = await getProfessionalProfileId(req.user);
      if (!profileId) {
        return res.status(404).json({ success: false, error: 'Professional profile not found' });
      }
      filter.professionalId = profileId;
      filter.professionalType = mapUserRoleToProfessionalType(normalizedRole);
    } else {
      return res.status(403).json({ success: false, error: 'Not authorized to view commissions' });
    }

    // ---- additional filters ----
    if (payoutStatus) filter.payoutStatus = payoutStatus;
    if (cycle) filter['commissionCycle.cycleNumber'] = cycle;

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      filter.createdAt = { $gte: start, $lte: end };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limNum = Math.min(1000, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limNum;

    // ---- query ----
    const commissions = await Commission.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limNum)
      .populate('appointmentId', 'appointmentDate type consultationFee patientId')
      .populate('patientId', 'name phone')
      // IMPORTANT: professionalId is refPath => needs professionalType present in doc
      .populate({ path: 'professionalId', select: 'name labName' });

    const total = await Commission.countDocuments(filter);

    // ---- totals ----
    const totalsAgg = await Commission.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: '$platformCommission' },
          totalProfessionalEarnings: { $sum: '$professionalEarning' },
          totalConsultationFees: { $sum: '$consultationFee' },
          totalPaid: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] } },
          totalProcessing: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'processing'] }, '$platformCommission', 0] } },
          totalPending: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] } },
          count: { $sum: 1 },
          paidCount: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, 1, 0] } }
        }
      }
    ]);

    const settings = await CommissionSettings.findOne();

    const currentDate = new Date();
    const currentCycle = `${String(currentDate.getUTCMonth() + 1).padStart(2, '0')}${currentDate.getUTCFullYear()}`;

    res.json({
      success: true,
      commissions,
      totals: totalsAgg[0] || {
        totalCommission: 0,
        totalProfessionalEarnings: 0,
        totalConsultationFees: 0,
        totalPaid: 0,
        totalProcessing: 0,
        totalPending: 0,
        count: 0,
        paidCount: 0,
        pendingCount: 0
      },
      settings: settings ? {
        defaultDoctorCommission: settings.defaultDoctorCommission,
        defaultPhysioCommission: settings.defaultPhysioCommission,
        defaultPathologyCommission: settings.defaultPathologyCommission,
        payoutThreshold: settings.payoutThreshold,
        payoutSchedule: settings.payoutSchedule
      } : null,
      currentCycle,
      pagination: {
        page: pageNum,
        limit: limNum,
        total,
        pages: Math.ceil(total / limNum)
      }
    });
  } catch (error) {
    console.error('Error fetching commissions (detailed):', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch commissions' });
  }
};

// Get commission report with grouping
exports.getCommissionReport = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'month', professionalType } = req.query;
    
    const matchStage = {};
    
    // Date range filter
    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      matchStage.createdAt = {
        $gte: start,
        $lte: end
      };
    }
    
    // Role-based filter
    if (['doctor', 'physio', 'pathology'].includes(req.user.role)) {
      // Get professional profile ID
      const profileId = await getProfessionalProfileId(req.user);
      if (!profileId) {
        return res.status(404).json({
          success: false,
          error: 'Professional profile not found'
        });
      }
      
      matchStage.professionalId = profileId;
      matchStage.professionalType = mapUserRoleToProfessionalType(req.user.role);
    } else if (req.user.role === 'admin') {
      // Admin can filter by professional type
      if (professionalType) {
        matchStage.professionalType = professionalType;
      }
    } else {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to view commission reports'
      });
    }
    
    let groupStage;
    let sortStage;
    
    if (groupBy === 'month') {
      groupStage = {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultationFees: { $sum: '$consultationFee' },
        count: { $sum: 1 },
        paidAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
        },
        pendingAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
        }
      };
      sortStage = { '_id.year': -1, '_id.month': -1 };
    } else if (groupBy === 'professional') {
      groupStage = {
        _id: {
          professionalId: '$professionalId',
          professionalType: '$professionalType'
        },
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultationFees: { $sum: '$consultationFee' },
        count: { $sum: 1 },
        paidAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
        },
        pendingAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
        }
      };
      sortStage = { totalCommission: -1 };
    } else if (groupBy === 'payoutStatus') {
      groupStage = {
        _id: '$payoutStatus',
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultationFees: { $sum: '$consultationFee' },
        count: { $sum: 1 }
      };
      sortStage = { _id: 1 };
    } else if (groupBy === 'cycle') {
      groupStage = {
        _id: '$commissionCycle.cycleNumber',
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        totalConsultationFees: { $sum: '$consultationFee' },
        count: { $sum: 1 },
        paidAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
        },
        pendingAmount: {
          $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
        }
      };
      sortStage = { _id: -1 };
    }
    
    const report = await Commission.aggregate([
      { $match: matchStage },
      { $group: groupStage },
      { $sort: sortStage }
    ]);
    
    // Get professional details if grouped by professional
    if (groupBy === 'professional') {
      for (const item of report) {
        let professional;
        if (item._id.professionalType === 'doctor') {
          professional = await DoctorProfile.findById(item._id.professionalId)
            .select('name specialization consultationFee totalEarnings');
        } else if (item._id.professionalType === 'physiotherapist') {
          professional = await PhysiotherapistProfile.findById(item._id.professionalId)
            .select('name services consultationFee totalEarnings');
        } else if (item._id.professionalType === 'pathology') {
          professional = await PathologyProfile.findById(item._id.professionalId)
            .select('labName services totalRevenue');
        }
        item.professional = professional;
      }
    }
    
    res.json({
      success: true,
      report,
      groupBy,
      period: startDate && endDate ? { startDate, endDate } : null,
      totalRecords: report.length
    });
  } catch (error) {
    console.error('Error fetching commission report:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission report'
    });
  }
};

// Get commission cycles (admin only)
exports.getCommissionCycles = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    const cycles = await Commission.aggregate([
      {
        $group: {
          _id: '$commissionCycle.cycleNumber',
          month: { $first: '$commissionCycle.month' },
          year: { $first: '$commissionCycle.year' },
          totalCommission: { $sum: '$platformCommission' },
          totalEarnings: { $sum: '$professionalEarning' },
          totalConsultationFees: { $sum: '$consultationFee' },
          count: { $sum: 1 },
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
      cycles,
      count: cycles.length
    });
  } catch (error) {
    console.error('Error fetching commission cycles:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission cycles'
    });
  }
};

// Get commission summary (admin only)
exports.getCommissionSummary = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();
    const currentCycle = `${currentMonth.toString().padStart(2, '0')}${currentYear}`;
    
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const lastCycle = `${lastMonth.toString().padStart(2, '0')}${lastMonthYear}`;
    
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
          count: { $sum: 1 },
          paidAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0] }
          },
          pendingAmount: {
            $sum: { $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0] }
          }
        }
      }
    ]);
    
    // Last month summary
    const lastMonthSummary = await Commission.aggregate([
      {
        $match: {
          'commissionCycle.cycleNumber': lastCycle
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
      } else if (professional._id.professionalType === 'physiotherapist') {
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
    
    // Get commission settings
    const settings = await CommissionSettings.findOne();
    
    res.json({
      success: true,
      summary: {
        currentMonth: currentMonthSummary,
        lastMonth: lastMonthSummary[0] || { totalCommission: 0, totalEarnings: 0, count: 0 },
        yearToDate: ytdSummary[0] || { totalCommission: 0, totalEarnings: 0, count: 0 },
        pendingPayout: pendingPayout[0] || { totalAmount: 0, count: 0 },
        topProfessionals,
        currentCycle,
        settings: settings ? {
          payoutThreshold: settings.payoutThreshold,
          payoutSchedule: settings.payoutSchedule
        } : null
      }
    });
  } catch (error) {
    console.error('Error fetching commission summary:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch commission summary'
    });
  }
};

// Process payout (admin only)
exports.processPayout = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    const { 
      commissionIds, 
      payoutMethod, 
      payoutDate, 
      cycleNumber,
      notes 
    } = req.body;
    
    // Validate input
    if (!commissionIds || !Array.isArray(commissionIds) || commissionIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Commission IDs array is required'
      });
    }
    
    if (!payoutMethod) {
      return res.status(400).json({
        success: false,
        error: 'Payout method is required'
      });
    }
    
    const validPayoutMethods = ['bank_transfer', 'upi', 'cash', 'cheque'];
    if (!validPayoutMethods.includes(payoutMethod)) {
      return res.status(400).json({
        success: false,
        error: `Invalid payout method. Must be one of: ${validPayoutMethods.join(', ')}`
      });
    }
    
    // Get commissions
    const commissions = await Commission.find({
      _id: { $in: commissionIds },
      payoutStatus: 'pending'
    });
    
    if (commissions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No pending commissions found'
      });
    }
    
    // Check if all commissions belong to the same cycle
    const uniqueCycles = [...new Set(commissions.map(c => c.commissionCycle.cycleNumber))];
    if (uniqueCycles.length > 1) {
      return res.status(400).json({
        success: false,
        error: 'Commissions must be from the same cycle for payout'
      });
    }
    
    const targetCycle = cycleNumber || uniqueCycles[0];
    
    // Calculate total amount
    const totalAmount = commissions.reduce((sum, commission) => sum + commission.platformCommission, 0);
    
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
      commissionsByProfessional[key].totalAmount += commission.platformCommission;
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
      payoutDate: payoutDate ? new Date(payoutDate) : new Date(),
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
    console.error('Error processing payout:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Generate payout report (admin only)
exports.generatePayoutReport = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
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
      .populate('professionalId', 'name')
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
      const cycle = commission.commissionCycle.cycleNumber;
      const professionalKey = `${commission.professionalType}_${commission.professionalId._id}`;
      
      if (!report[cycle]) {
        report[cycle] = {};
      }
      
      if (!report[cycle][professionalKey]) {
        report[cycle][professionalKey] = {
          professionalType: commission.professionalType,
          professionalId: commission.professionalId._id,
          professionalName: commission.professionalId.name,
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
      
      report[cycle][professionalKey].totalAmount += commission.platformCommission;
      report[cycle][professionalKey].commissionCount += 1;
    });
    
    // Convert to array format
    const reportArray = [];
    for (const cycle in report) {
      for (const professionalKey in report[cycle]) {
        const professionalData = report[cycle][professionalKey];
        
        // Get professional bank details
        let bankDetails = null;
        if (professionalData.professionalType === 'doctor') {
          const doctor = await DoctorProfile.findById(professionalData.professionalId)
            .select('bankDetails');
          bankDetails = doctor?.bankDetails;
        } else if (professionalData.professionalType === 'physiotherapist') {
          const physio = await PhysiotherapistProfile.findById(professionalData.professionalId)
            .select('bankDetails');
          bankDetails = physio?.bankDetails;
        } else if (professionalData.professionalType === 'pathology') {
          const pathology = await PathologyProfile.findById(professionalData.professionalId)
            .select('bankDetails');
          bankDetails = pathology?.bankDetails;
        }
        
        reportArray.push({
          cycle,
          ...professionalData,
          bankDetails,
          eligibleForPayout: professionalData.totalAmount >= (await getPayoutThreshold())
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
    console.error('Error generating payout report:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to generate payout report'
    });
  }
};

// Mark payout as paid (admin only)
exports.markPayoutAsPaid = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
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
    
    res.json({
      success: true,
      message: `Payout ${payout.payoutNumber} marked as paid`,
      payout
    });
  } catch (error) {
    console.error('Error marking payout as paid:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to mark payout as paid'
    });
  }
};

// ========== HELPER FUNCTIONS ==========

// Get professional profile ID
async function getProfessionalProfileId(user) {
  try {
    let profile = null;
    
    if (user.role === 'doctor') {
      profile = await DoctorProfile.findOne({ userId: user.id });
    } else if (user.role === 'physio') {
      profile = await PhysiotherapistProfile.findOne({ userId: user.id });
    } else if (user.role === 'pathology') {
      profile = await PathologyProfile.findOne({ userId: user.id });
    }
    
    return profile ? profile._id : null;
  } catch (error) {
    console.error('Error getting professional profile ID:', error);
    return null;
  }
}

// Map user role to professional type
function mapUserRoleToProfessionalType(userRole) {
  const roleMap = {
    'doctor': 'doctor',
    'physio': 'physiotherapist',
    'pathology': 'pathology'
  };
  
  return roleMap[userRole] || userRole;
}

// Get payout threshold
async function getPayoutThreshold() {
  try {
    const settings = await CommissionSettings.findOne();
    return settings?.payoutThreshold || 1000;
  } catch (error) {
    console.error('Error getting payout threshold:', error);
    return 1000;
  }
}

// Update professional commission after payout
async function updateProfessionalCommissionAfterPayout(professionalType, professionalId, amount) {
  try {
    const updateFields = {
      $inc: {
        pendingCommission: -amount,
        paidCommission: amount,
        totalEarnings: amount // This is professional earning, not commission
      }
    };
    
    if (professionalType === 'doctor') {
      await DoctorProfile.findByIdAndUpdate(professionalId, updateFields);
    } else if (professionalType === 'physiotherapist') {
      await PhysiotherapistProfile.findByIdAndUpdate(professionalId, updateFields);
    } else if (professionalType === 'pathology') {
      await PathologyProfile.findByIdAndUpdate(professionalId, updateFields);
    }
  } catch (error) {
    console.error('Error updating professional commission:', error);
  }
}

// Update professional pending commission (bulk)
async function updateProfessionalPendingCommission(commissions) {
  const grouped = {};
  
  commissions.forEach(commission => {
    const key = `${commission.professionalType}_${commission.professionalId}`;
    if (!grouped[key]) {
      grouped[key] = {
        type: commission.professionalType,
        id: commission.professionalId,
        amount: 0
      };
    }
    grouped[key].amount += commission.platformCommission;
  });
  
  for (const key in grouped) {
    const { type, id, amount } = grouped[key];
    
    await updateProfessionalCommissionAfterPayout(type, id, amount);
  }
}