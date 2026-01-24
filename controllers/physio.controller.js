const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const Appointment = require('../models/Appointment');
const Commission = require('../models/Commission');
const Calendar = require('../models/Calendar');

exports.getProfile = async (req, res) => {
  try {
    const profile = await PhysiotherapistProfile.findOne({ 
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
    
    // Remove fields that shouldn't be updated directly
    delete updates.verificationStatus;
    delete updates.totalEarnings;
    delete updates.averageRating;
    
    const profile = await PhysiotherapistProfile.findOneAndUpdate(
      { userId: req.user.id },
      updates,
      { new: true, runValidators: true }
    );
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateAvailability = async (req, res) => {
  try {
    const { availability, servesAreas } = req.body;
    
    const profile = await PhysiotherapistProfile.findOneAndUpdate(
      { userId: req.user.id },
      { availability, servesAreas },
      { new: true }
    );
    
    // Update calendar
    await updateCalendarAvailability(req.user.profileId, 'physiotherapist', availability);
    
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
      startDate,
      endDate,
      page = 1,
      limit = 20 
    } = req.query;
    
    const filter = { 
      physioId: req.user.profileId,
      professionalType: 'physiotherapist'
    };
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.appointmentDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender')
      .sort({ appointmentDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await Appointment.countDocuments(filter);
    
    // Get today's appointments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaysAppointments = await Appointment.countDocuments({
      physioId: req.user.profileId,
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted'] }
    });
    
    res.json({
      success: true,
      appointments,
      todaysAppointments,
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

exports.getEarnings = async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'month' } = req.query;
    
    const matchStage = {
      professionalId: req.user.profileId,
      professionalType: 'physiotherapist',
      payoutStatus: { $in: ['paid', 'pending'] }
    };
    
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
        totalEarnings: { $sum: '$professionalEarning' },
        totalCommission: { $sum: '$platformCommission' },
        appointmentCount: { $sum: 1 }
      };
    } else if (groupBy === 'day') {
      groupStage = {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' }
        },
        totalEarnings: { $sum: '$professionalEarning' },
        totalCommission: { $sum: '$platformCommission' },
        appointmentCount: { $sum: 1 }
      };
    }
    
    const earnings = await Commission.aggregate([
      { $match: matchStage },
      { $group: groupStage },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get pending commission
    const pendingCommission = await Commission.aggregate([
      {
        $match: {
          professionalId: req.user.profileId,
          professionalType: 'physiotherapist',
          payoutStatus: 'pending'
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$platformCommission' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Get profile stats
    const profile = await PhysiotherapistProfile.findById(req.user.profileId)
      .select('totalEarnings pendingCommission paidCommission totalConsultations');
    
    res.json({
      success: true,
      earnings,
      pendingCommission: pendingCommission[0]?.total || 0,
      profileStats: {
        totalEarnings: profile?.totalEarnings || 0,
        pendingCommission: profile?.pendingCommission || 0,
        paidCommission: profile?.paidCommission || 0,
        totalConsultations: profile?.totalConsultations || 0
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper function
async function updateCalendarAvailability(physioId, type, availability) {
  // Update calendar with new availability
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  
  let calendar = await Calendar.findOne({ year, month });
  
  if (!calendar) {
    calendar = await Calendar.create({ year, month, days: [] });
  }
  
  // Update calendar days based on availability
  // Implementation depends on your calendar structure
}