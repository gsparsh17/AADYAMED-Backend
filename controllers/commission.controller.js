const Commission = require('../models/Commission');
const CommissionSettings = require('../models/CommissionSettings');
const Appointment = require('../models/Appointment');

exports.getCommissions = async (req, res) => {
  try {
    const { 
      professionalId,
      professionalType,
      payoutStatus,
      cycle,
      page = 1,
      limit = 20 
    } = req.query;
    
    const filter = {};
    
    // Admin can view all, professionals can view their own
    if (req.user.role === 'admin') {
      if (professionalId) filter.professionalId = professionalId;
      if (professionalType) filter.professionalType = professionalType;
    } else if (['doctor', 'physiotherapist', 'pathology'].includes(req.user.role)) {
      filter.professionalId = req.user.profileId;
      filter.professionalType = req.user.role;
    } else {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    if (payoutStatus) filter.payoutStatus = payoutStatus;
    if (cycle) filter['commissionCycle.cycleNumber'] = cycle;
    
    const commissions = await Commission.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('appointmentId', 'appointmentDate type consultationFee')
      .populate('patientId', 'name');
    
    const total = await Commission.countDocuments(filter);
    
    // Calculate totals
    const totals = await Commission.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: '$platformCommission' },
          totalPaid: { 
            $sum: {
              $cond: [{ $eq: ['$payoutStatus', 'paid'] }, '$platformCommission', 0]
            }
          },
          totalPending: {
            $sum: {
              $cond: [{ $eq: ['$payoutStatus', 'pending'] }, '$platformCommission', 0]
            }
          }
        }
      }
    ]);
    
    res.json({
      success: true,
      commissions,
      totals: totals[0] || { totalCommission: 0, totalPaid: 0, totalPending: 0 },
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

exports.processPayout = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }
    
    const { commissionIds, payoutMethod, payoutDate } = req.body;
    
    const commissions = await Commission.find({
      _id: { $in: commissionIds },
      payoutStatus: 'pending'
    });
    
    if (commissions.length === 0) {
      return res.status(400).json({ message: 'No pending commissions found' });
    }
    
    // Update commissions
    const updatePromises = commissions.map(commission => {
      commission.payoutStatus = 'processing';
      commission.payoutMethod = payoutMethod;
      commission.payoutDate = payoutDate || new Date();
      commission.paidBy = req.user.id;
      return commission.save();
    });
    
    await Promise.all(updatePromises);
    
    // In real implementation, integrate with payment gateway here
    // For now, mark as paid
    await Commission.updateMany(
      { _id: { $in: commissionIds } },
      { 
        payoutStatus: 'paid',
        paidAt: new Date()
      }
    );
    
    // Update professional's pending commission
    await updateProfessionalPendingCommission(commissions);
    
    res.json({
      success: true,
      message: `Processed ${commissions.length} commission(s) for payout`
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

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
    
    // Role-based filter
    if (['doctor', 'physiotherapist', 'pathology'].includes(req.user.role)) {
      matchStage.professionalId = req.user.profileId;
      matchStage.professionalType = req.user.role;
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
        count: { $sum: 1 }
      };
    } else if (groupBy === 'professional') {
      groupStage = {
        _id: '$professionalId',
        professionalType: { $first: '$professionalType' },
        totalCommission: { $sum: '$platformCommission' },
        totalEarnings: { $sum: '$professionalEarning' },
        count: { $sum: 1 }
      };
    }
    
    const report = await Commission.aggregate([
      { $match: matchStage },
      { $group: groupStage },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get professional details if grouped by professional
    if (groupBy === 'professional') {
      for (const item of report) {
        let professional;
        if (item.professionalType === 'doctor') {
          professional = await DoctorProfile.findById(item._id).select('name specialization');
        } else if (item.professionalType === 'physiotherapist') {
          professional = await PhysiotherapistProfile.findById(item._id).select('name specialization');
        }
        item.professional = professional;
      }
    }
    
    res.json({ success: true, report });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function
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
    
    if (type === 'doctor') {
      await DoctorProfile.findByIdAndUpdate(id, {
        $inc: { 
          pendingCommission: -amount,
          paidCommission: amount
        }
      });
    } else if (type === 'physiotherapist') {
      await PhysiotherapistProfile.findByIdAndUpdate(id, {
        $inc: { 
          pendingCommission: -amount,
          paidCommission: amount
        }
      });
    }
  }
}