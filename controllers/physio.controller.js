const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const Appointment = require('../models/Appointment');
const Commission = require('../models/Commission');
const Calendar = require('../models/Calendar');

// ========== PHYSIO-ONLY FUNCTIONS ==========

// Get current physio's profile
exports.getProfile = async (req, res) => {
  try {
    const profile = await PhysiotherapistProfile.findOne({ 
      userId: req.user.id 
    }).populate('userId', 'email isVerified lastLogin');
    
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    // Set profileId in user object for other functions
    req.user.profileId = profile._id;
    
    res.json({ 
      success: true, 
      profile 
    });
  } catch (error) {
    console.error('Error fetching physio profile:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch profile' 
    });
  }
};

// Update current physio's profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    
    // Remove fields that shouldn't be updated directly
    delete updates.verificationStatus;
    delete updates.totalEarnings;
    delete updates.averageRating;
    delete updates.totalConsultations;
    delete updates.pendingCommission;
    delete updates.paidCommission;
    delete updates.userId;
    
    // Get profile ID first
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const updatedProfile = await PhysiotherapistProfile.findByIdAndUpdate(
      profile._id,
      updates,
      { new: true, runValidators: true }
    );
    
    res.json({ 
      success: true, 
      message: 'Profile updated successfully',
      profile: updatedProfile 
    });
  } catch (error) {
    console.error('Error updating physio profile:', error.message);
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Update current physio's availability
exports.updateAvailability = async (req, res) => {
  try {
    const { availability, servesAreas } = req.body;
    
    // Get profile ID first
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const updateData = {};
    if (availability) updateData.availability = availability;
    if (servesAreas) updateData.servesAreas = servesAreas;
    
    const updatedProfile = await PhysiotherapistProfile.findByIdAndUpdate(
      profile._id,
      updateData,
      { new: true }
    );
    
    // Update calendar if availability changed
    if (availability) {
      try {
        await updateCalendarAvailability(profile._id, 'physio', availability);
      } catch (calendarError) {
        console.error('Error updating calendar:', calendarError.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Availability updated successfully',
      profile: updatedProfile 
    });
  } catch (error) {
    console.error('Error updating availability:', error.message);
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Add break to schedule
exports.addBreak = async (req, res) => {
  try {
    const { date, startTime, endTime, reason } = req.body;
    
    if (!date || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Date, startTime, and endTime are required'
      });
    }
    
    // Get profile ID
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const breakDate = new Date(date);
    const year = breakDate.getFullYear();
    const month = breakDate.getMonth() + 1;
    const dateStr = breakDate.toISOString().split('T')[0];
    
    // Find or create calendar
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = new Calendar({ 
        year, 
        month, 
        days: [] 
      });
    }
    
    // Find or create day
    let day = calendar.days.find(d => {
      const dDate = new Date(d.date);
      const dStr = dDate.toISOString().split('T')[0];
      return dStr === dateStr;
    });
    
    if (!day) {
      const dayName = breakDate.toLocaleDateString('en-US', { weekday: 'long' });
      day = {
        date: breakDate,
        dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        isHoliday: false,
        professionals: []
      };
      calendar.days.push(day);
    }
    
    // Find or create professional entry
    let professional = day.professionals.find(
      p => p.professionalId.toString() === profile._id.toString() && 
           p.professionalType === 'physio'
    );
    
    if (!professional) {
      // Check physio's availability for this day
      const dayName = breakDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const dayAvailability = profile.availability?.find(a => a.day === dayName);
      
      const bookedSlots = dayAvailability?.slots?.map(slot => ({
        startTime: slot.startTime,
        endTime: slot.endTime,
        isBooked: false,
        type: slot.type || 'clinic'
      })) || [];
      
      professional = {
        professionalId: profile._id,
        professionalType: 'physio',
        bookedSlots: bookedSlots,
        breaks: [],
        isAvailable: true
      };
      day.professionals.push(professional);
    }
    
    // Add break
    professional.breaks.push({
      startTime,
      endTime,
      reason: reason || 'Break'
    });
    
    await calendar.save();
    
    res.json({
      success: true,
      message: 'Break added successfully',
      break: { date: dateStr, startTime, endTime, reason }
    });
  } catch (error) {
    console.error('Error adding break:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to add break'
    });
  }
};

// Get current physio's appointments
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
    
    // Get profile ID first
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const filter = { 
      physioId: profile._id,
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
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('referralId', 'requirement')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Appointment.countDocuments(filter);
    
    // Get today's appointments
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const todaysAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physiotherapist',
      appointmentDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    });
    
    // Get upcoming appointments
    const upcomingAppointments = await Appointment.find({
      physioId: profile._id,
      professionalType: 'physiotherapist',
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    })
    .populate('patientId', 'name phone')
    .sort({ appointmentDate: 1 })
    .limit(5);
    
    res.json({
      success: true,
      appointments,
      todaysAppointments,
      upcomingAppointments,
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

// Get current physio's earnings summary
exports.getEarnings = async (req, res) => {
  try {
    // Get profile ID first
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .select('totalEarnings pendingCommission paidCommission totalConsultations');
    
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: profile._id,
          professionalType: 'physiotherapist',
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$professionalEarning' },
          totalCommission: { $sum: '$platformCommission' }
        }
      }
    ]);
    
    res.json({
      success: true,
      earnings: {
        totalEarnings: profile.totalEarnings || 0,
        pendingCommission: profile.pendingCommission || 0,
        paidCommission: profile.paidCommission || 0,
        monthlyEarnings: monthlyEarnings[0]?.totalEarnings || 0,
        monthlyCommission: monthlyEarnings[0]?.totalCommission || 0
      },
      stats: {
        totalConsultations: profile.totalConsultations || 0
      }
    });
  } catch (error) {
    console.error('Error fetching earnings:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch earnings data' 
    });
  }
};

// Get current physio's detailed earnings report
exports.getEarningsReport = async (req, res) => {
  try {
    // Get profile ID first
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const { startDate, endDate, groupBy = 'month' } = req.query;
    
    const matchStage = {
      professionalId: profile._id,
      professionalType: 'physiotherapist'
    };
    
    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const earnings = await Commission.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: groupBy === 'month' ? {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          } : {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          totalEarnings: { $sum: '$professionalEarning' },
          totalCommission: { $sum: '$platformCommission' },
          appointmentCount: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);
    
    // Get pending commission
    const pendingCommission = await Commission.aggregate([
      {
        $match: {
          professionalId: profile._id,
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
    
    res.json({
      success: true,
      earnings,
      pendingCommission: pendingCommission[0]?.total || 0,
      profileStats: {
        totalEarnings: profile.totalEarnings || 0,
        pendingCommission: profile.pendingCommission || 0,
        paidCommission: profile.paidCommission || 0
      }
    });
  } catch (error) {
    console.error('Error fetching earnings report:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch earnings report' 
    });
  }
};

// Get current physio's dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    // Get profile ID first
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .select('name services averageRating totalConsultations totalEarnings servesAreas');
    
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Get today's appointments
    const todaysAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physiotherapist',
      appointmentDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['confirmed', 'accepted'] }
    });
    
    // Get pending appointments
    const pendingAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physiotherapist',
      status: 'pending'
    });
    
    // Get this week's appointments
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    
    const weeklyAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physiotherapist',
      appointmentDate: { $gte: startOfWeek, $lte: endOfWeek },
      status: { $in: ['confirmed', 'accepted', 'completed'] }
    });
    
    // Get this month's earnings
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: profile._id,
          professionalType: 'physiotherapist',
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$professionalEarning' }
        }
      }
    ]);
    
    // Get recent appointments
    const recentAppointments = await Appointment.find({
      physioId: profile._id,
      professionalType: 'physiotherapist'
    })
    .populate('patientId', 'name age gender')
    .sort({ appointmentDate: -1 })
    .limit(5);
    
    // Get upcoming appointments (next 3 days)
    const threeDaysLater = new Date(today);
    threeDaysLater.setDate(today.getDate() + 3);
    
    const upcomingAppointments = await Appointment.find({
      physioId: profile._id,
      professionalType: 'physiotherapist',
      appointmentDate: { $gte: today, $lte: threeDaysLater },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    })
    .populate('patientId', 'name phone')
    .sort({ appointmentDate: 1 })
    .limit(10);
    
    res.json({
      success: true,
      stats: {
        totalConsultations: profile.totalConsultations || 0,
        totalEarnings: profile.totalEarnings || 0,
        averageRating: profile.averageRating || 0,
        todaysAppointments,
        pendingAppointments,
        weeklyAppointments,
        monthlyEarnings: monthlyEarnings[0]?.total || 0
      },
      profile: {
        name: profile.name,
        services: profile.services,
        servesAreas: profile.servesAreas
      },
      recentAppointments,
      upcomingAppointments
    });
  } catch (error) {
    console.error('Error fetching physio dashboard:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
};

// ========== HELPER FUNCTIONS ==========

// Helper function to update calendar availability
async function updateCalendarAvailability(physioId, type, availability) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Update next 30 days
  const datesToUpdate = [];
  for (let i = 0; i <= 30; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    date.setHours(0, 0, 0, 0);
    datesToUpdate.push(date);
  }
  
  // Get current month/year for calendar
  const targetDate = new Date();
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  
  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) {
    calendar = new Calendar({ 
      year, 
      month, 
      days: [] 
    });
  }
  
  let updated = false;
  
  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    
    const dayAvailability = availability?.find(a => a.day === dayName);
    
    const existingDayIndex = calendar.days.findIndex(
      d => d.date.toISOString().split('T')[0] === dateStr
    );
    
    if (existingDayIndex !== -1) {
      const existingDay = calendar.days[existingDayIndex];
      const professionalIndex = existingDay.professionals.findIndex(
        p => p.professionalId.toString() === physioId.toString() && 
             p.professionalType === type
      );
      
      if (professionalIndex !== -1) {
        if (!dayAvailability) {
          existingDay.professionals.splice(professionalIndex, 1);
          updated = true;
        } else {
          const bookedSlots = dayAvailability.slots.map(slot => ({
            startTime: slot.startTime,
            endTime: slot.endTime,
            isBooked: false,
            type: slot.type || 'clinic'
          }));
          
          existingDay.professionals[professionalIndex].bookedSlots = bookedSlots;
          updated = true;
        }
      } else if (dayAvailability) {
        const bookedSlots = dayAvailability.slots.map(slot => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          isBooked: false,
          type: slot.type || 'clinic'
        }));
        
        existingDay.professionals.push({
          professionalId: physioId,
          professionalType: type,
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        });
        updated = true;
      }
    } else if (dayAvailability) {
      const bookedSlots = dayAvailability.slots.map(slot => ({
        startTime: slot.startTime,
        endTime: slot.endTime,
        isBooked: false,
        type: slot.type || 'clinic'
      }));
      
      calendar.days.push({
        date: targetDate,
        dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        isHoliday: false,
        professionals: [{
          professionalId: physioId,
          professionalType: type,
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        }]
      });
      updated = true;
    }
  }
  
  if (updated) {
    // Filter to keep only next 30 days
    const todayStr = today.toISOString().split('T')[0];
    calendar.days = calendar.days.filter(day => {
      const dayDate = new Date(day.date);
      const diffDays = Math.floor((dayDate - today) / (1000 * 60 * 60 * 24));
      return diffDays >= 0 && diffDays <= 30;
    });
    
    // Sort days chronologically
    calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    await calendar.save();
  }
}