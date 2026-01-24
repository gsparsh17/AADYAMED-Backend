const PathologyProfile = require('../models/PathologyProfile');
const LabTest = require('../models/LabTest');
const Appointment = require('../models/Appointment');

exports.getProfile = async (req, res) => {
  try {
    const profile = await PathologyProfile.findOne({ 
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
    delete updates.totalTestsConducted;
    
    const profile = await PathologyProfile.findOneAndUpdate(
      { userId: req.user.id },
      updates,
      { new: true, runValidators: true }
    );
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getTestSlots = async (req, res) => {
  try {
    const { date } = req.query;
    const profile = await PathologyProfile.findById(req.user.profileId);
    
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    
    let slots = [];
    
    if (date) {
      const selectedDate = new Date(date);
      const daySlots = profile.testSlots.find(slot => 
        slot.date.toDateString() === selectedDate.toDateString()
      );
      
      if (daySlots) {
        slots = daySlots.timeSlots;
      }
    } else {
      // Return next 7 days slots
      const today = new Date();
      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);
      
      slots = profile.testSlots
        .filter(slot => slot.date >= today && slot.date <= nextWeek)
        .map(slot => ({
          date: slot.date,
          timeSlots: slot.timeSlots
        }));
    }
    
    res.json({ success: true, slots });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateTestSlots = async (req, res) => {
  try {
    const { date, timeSlots } = req.body;
    
    const profile = await PathologyProfile.findById(req.user.profileId);
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    
    const slotDate = new Date(date);
    
    // Find existing slot for this date
    const existingSlotIndex = profile.testSlots.findIndex(slot => 
      slot.date.toDateString() === slotDate.toDateString()
    );
    
    if (existingSlotIndex >= 0) {
      profile.testSlots[existingSlotIndex].timeSlots = timeSlots;
    } else {
      profile.testSlots.push({
        date: slotDate,
        timeSlots
      });
    }
    
    await profile.save();
    
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getLabTests = async (req, res) => {
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
      pathologyId: req.user.profileId
    };
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.scheduledDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const labTests = await LabTest.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('doctorId', 'name specialization')
      .populate('appointmentId', 'appointmentDate')
      .sort({ scheduledDate: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    
    const total = await LabTest.countDocuments(filter);
    
    // Get today's tests
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todaysTests = await LabTest.countDocuments({
      pathologyId: req.user.profileId,
      scheduledDate: { $gte: today },
      status: { $in: ['scheduled', 'sample_collected'] }
    });
    
    // Get statistics
    const stats = await LabTest.aggregate([
      { $match: { pathologyId: req.user.profileId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      labTests,
      todaysTests,
      stats,
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
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    
    const profile = await PathologyProfile.findById(req.user.profileId);
    
    const monthlyStats = await LabTest.aggregate([
      {
        $match: {
          pathologyId: req.user.profileId,
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' },
          pendingTests: {
            $sum: { $cond: [{ $in: ['$status', ['requested', 'scheduled']] }, 1, 0] }
          },
          completedTests: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Get popular tests
    const popularTests = await LabTest.aggregate([
      { $match: { pathologyId: req.user.profileId } },
      { $unwind: '$tests' },
      {
        $group: {
          _id: '$tests.testName',
          count: { $sum: 1 },
          totalRevenue: { $sum: '$tests.price' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);
    
    res.json({
      success: true,
      stats: monthlyStats[0] || {
        totalTests: 0,
        totalRevenue: 0,
        pendingTests: 0,
        completedTests: 0
      },
      popularTests,
      profile: {
        labName: profile.labName,
        averageRating: profile.averageRating,
        totalTestsConducted: profile.totalTestsConducted
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};