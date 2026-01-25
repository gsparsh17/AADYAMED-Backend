const PathologyProfile = require('../models/PathologyProfile');
const LabTest = require('../models/LabTest');
const Appointment = require('../models/Appointment');

// ========== PATHOLOGY-ONLY FUNCTIONS ==========

// Get current pathology's profile
exports.getProfile = async (req, res) => {
  try {
    const profile = await PathologyProfile.findOne({ 
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
    console.error('Error fetching pathology profile:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch profile' 
    });
  }
};

// Update current pathology's profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    
    // Remove fields that shouldn't be updated directly
    delete updates.verificationStatus;
    delete updates.totalTestsConducted;
    delete updates.totalRevenue;
    delete updates.averageRating;
    delete updates.commissionRate;
    delete updates.userId;
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const updatedProfile = await PathologyProfile.findByIdAndUpdate(
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
    console.error('Error updating pathology profile:', error.message);
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Get current pathology's test slots
exports.getTestSlots = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .select('testSlots labName homeCollectionAvailable');
    
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    let slots = [];
    
    if (date) {
      // Get slots for specific date
      const selectedDate = new Date(date);
      selectedDate.setHours(0, 0, 0, 0);
      
      const daySlots = profile.testSlots.find(slot => {
        const slotDate = new Date(slot.date);
        slotDate.setHours(0, 0, 0, 0);
        return slotDate.getTime() === selectedDate.getTime();
      });
      
      if (daySlots) {
        slots = [{
          date: daySlots.date,
          timeSlots: daySlots.timeSlots.map(slot => ({
            ...slot.toObject(),
            availableCapacity: slot.maxCapacity - (slot.bookedCount || 0)
          }))
        }];
      }
    } else if (startDate && endDate) {
      // Get slots for date range
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      slots = profile.testSlots
        .filter(slot => {
          const slotDate = new Date(slot.date);
          return slotDate >= start && slotDate <= end;
        })
        .map(slot => ({
          date: slot.date,
          timeSlots: slot.timeSlots.map(timeSlot => ({
            ...timeSlot.toObject(),
            availableCapacity: timeSlot.maxCapacity - (timeSlot.bookedCount || 0)
          }))
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    } else {
      // Return next 7 days slots
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const nextWeek = new Date(today);
      nextWeek.setDate(today.getDate() + 7);
      nextWeek.setHours(23, 59, 59, 999);
      
      slots = profile.testSlots
        .filter(slot => {
          const slotDate = new Date(slot.date);
          return slotDate >= today && slotDate <= nextWeek;
        })
        .map(slot => ({
          date: slot.date,
          timeSlots: slot.timeSlots.map(timeSlot => ({
            ...timeSlot.toObject(),
            availableCapacity: timeSlot.maxCapacity - (timeSlot.bookedCount || 0)
          }))
        }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    
    res.json({
      success: true,
      labName: profile.labName,
      homeCollectionAvailable: profile.homeCollectionAvailable,
      slots,
      count: slots.length
    });
  } catch (error) {
    console.error('Error fetching test slots:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch test slots' 
    });
  }
};

// Update current pathology's test slots for specific date
exports.updateTestSlots = async (req, res) => {
  try {
    const { date, timeSlots } = req.body;
    
    if (!date || !timeSlots || !Array.isArray(timeSlots)) {
      return res.status(400).json({
        success: false,
        error: 'Date and timeSlots array are required'
      });
    }
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const slotDate = new Date(date);
    slotDate.setHours(0, 0, 0, 0);
    
    // Validate time slots
    const validatedTimeSlots = timeSlots.map(slot => {
      if (!slot.startTime || !slot.endTime || !slot.maxCapacity) {
        throw new Error('Each time slot must have startTime, endTime, and maxCapacity');
      }
      
      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        maxCapacity: parseInt(slot.maxCapacity),
        bookedCount: parseInt(slot.bookedCount) || 0,
        isAvailable: slot.isAvailable !== false
      };
    });
    
    // Find existing slot for this date
    const existingSlotIndex = profile.testSlots.findIndex(slot => {
      const slotDateObj = new Date(slot.date);
      slotDateObj.setHours(0, 0, 0, 0);
      return slotDateObj.getTime() === slotDate.getTime();
    });
    
    if (existingSlotIndex >= 0) {
      // Check if there are existing bookings that exceed new capacity
      const existingSlot = profile.testSlots[existingSlotIndex];
      for (const timeSlot of existingSlot.timeSlots) {
        const newSlot = validatedTimeSlots.find(
          ts => ts.startTime === timeSlot.startTime && ts.endTime === timeSlot.endTime
        );
        
        if (newSlot && timeSlot.bookedCount > newSlot.maxCapacity) {
          return res.status(400).json({
            success: false,
            error: `Cannot reduce capacity for slot ${timeSlot.startTime}-${timeSlot.endTime}. ${timeSlot.bookedCount} appointments already booked.`
          });
        }
      }
      
      profile.testSlots[existingSlotIndex].timeSlots = validatedTimeSlots;
    } else {
      profile.testSlots.push({
        date: slotDate,
        timeSlots: validatedTimeSlots
      });
    }
    
    // Sort testSlots by date
    profile.testSlots.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    await profile.save();
    
    res.json({ 
      success: true, 
      message: 'Test slots updated successfully',
      date: slotDate,
      timeSlots: validatedTimeSlots
    });
  } catch (error) {
    console.error('Error updating test slots:', error.message);
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Bulk update test slots for multiple dates
exports.bulkUpdateTestSlots = async (req, res) => {
  try {
    const { slots } = req.body;
    
    if (!slots || !Array.isArray(slots)) {
      return res.status(400).json({
        success: false,
        error: 'Slots array is required'
      });
    }
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const updatedSlots = [];
    const errors = [];
    
    for (const slotData of slots) {
      try {
        const { date, timeSlots } = slotData;
        
        if (!date || !timeSlots || !Array.isArray(timeSlots)) {
          errors.push({ date, error: 'Invalid slot data' });
          continue;
        }
        
        const slotDate = new Date(date);
        slotDate.setHours(0, 0, 0, 0);
        
        // Validate time slots
        const validatedTimeSlots = timeSlots.map(slot => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          maxCapacity: parseInt(slot.maxCapacity) || 10,
          bookedCount: parseInt(slot.bookedCount) || 0,
          isAvailable: slot.isAvailable !== false
        }));
        
        // Find existing slot for this date
        const existingSlotIndex = profile.testSlots.findIndex(slot => {
          const slotDateObj = new Date(slot.date);
          slotDateObj.setHours(0, 0, 0, 0);
          return slotDateObj.getTime() === slotDate.getTime();
        });
        
        if (existingSlotIndex >= 0) {
          profile.testSlots[existingSlotIndex].timeSlots = validatedTimeSlots;
        } else {
          profile.testSlots.push({
            date: slotDate,
            timeSlots: validatedTimeSlots
          });
        }
        
        updatedSlots.push(date);
      } catch (slotError) {
        errors.push({ date: slotData.date, error: slotError.message });
      }
    }
    
    // Sort testSlots by date
    profile.testSlots.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    await profile.save();
    
    res.json({
      success: true,
      message: `Updated ${updatedSlots.length} date(s) successfully`,
      updatedSlots,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error in bulk update test slots:', error.message);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
};

// Get current pathology's lab tests
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
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const filter = { 
      pathologyId: profile._id
    };
    
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.scheduledDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const labTests = await LabTest.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('doctorId', 'name specialization')
      .populate('appointmentId', 'appointmentDate type')
      .sort({ scheduledDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await LabTest.countDocuments(filter);
    
    // Get today's tests
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const todaysTests = await LabTest.countDocuments({
      pathologyId: profile._id,
      scheduledDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['scheduled', 'sample_collected'] }
    });
    
    // Get statistics
    const stats = await LabTest.aggregate([
      { $match: { pathologyId: profile._id } },
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
    console.error('Error fetching lab tests:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch lab tests' 
    });
  }
};

// Get specific lab test by ID
exports.getLabTestById = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const labTest = await LabTest.findOne({
      _id: id,
      pathologyId: profile._id
    })
    .populate('patientId', 'name phone age gender bloodGroup address')
    .populate('doctorId', 'name specialization clinicAddress')
    .populate('appointmentId', 'appointmentDate type')
    .populate('prescriptionId', 'diagnosis medicines');
    
    if (!labTest) {
      return res.status(404).json({ 
        success: false,
        error: 'Lab test not found' 
      });
    }
    
    res.json({
      success: true,
      labTest
    });
  } catch (error) {
    console.error('Error fetching lab test:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch lab test' 
    });
  }
};

// Update lab test status
exports.updateTestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, sampleCollectedAt, sampleCollectedBy } = req.body;
    
    if (!status) {
      return res.status(400).json({
        success: false,
        error: 'Status is required'
      });
    }
    
    const validStatuses = ['requested', 'scheduled', 'sample_collected', 'processing', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const updateData = { status };
    
    // Add sample collection details if status is sample_collected
    if (status === 'sample_collected') {
      updateData.sampleCollectedAt = sampleCollectedAt ? new Date(sampleCollectedAt) : new Date();
      updateData.sampleCollectedBy = sampleCollectedBy || req.user.name;
    }
    
    // Add completed date if status is completed
    if (status === 'completed') {
      updateData.completedAt = new Date();
    }
    
    const labTest = await LabTest.findOneAndUpdate(
      { _id: id, pathologyId: profile._id },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!labTest) {
      return res.status(404).json({ 
        success: false,
        error: 'Lab test not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Test status updated successfully',
      labTest
    });
  } catch (error) {
    console.error('Error updating test status:', error.message);
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Upload test report
exports.uploadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { reportUrl, findings, remarks } = req.body;
    
    if (!reportUrl) {
      return res.status(400).json({
        success: false,
        error: 'Report URL is required'
      });
    }
    
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const updateData = {
      reportUrl,
      status: 'completed',
      completedAt: new Date(),
      findings: findings || '',
      remarks: remarks || ''
    };
    
    const labTest = await LabTest.findOneAndUpdate(
      { _id: id, pathologyId: profile._id },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!labTest) {
      return res.status(404).json({ 
        success: false,
        error: 'Lab test not found' 
      });
    }
    
    // Update pathology profile stats
    await PathologyProfile.findByIdAndUpdate(profile._id, {
      $inc: { totalTestsConducted: 1 }
    });
    
    res.json({
      success: true,
      message: 'Report uploaded successfully',
      labTest
    });
  } catch (error) {
    console.error('Error uploading report:', error.message);
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Get current pathology's dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    // Get profile ID first
    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .select('labName averageRating totalTestsConducted totalRevenue homeCollectionAvailable');
    
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    
    // Monthly stats
    const monthlyStats = await LabTest.aggregate([
      {
        $match: {
          pathologyId: profile._id,
          createdAt: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' },
          pendingTests: {
            $sum: { $cond: [{ $in: ['$status', ['requested', 'scheduled', 'sample_collected', 'processing']] }, 1, 0] }
          },
          completedTests: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Weekly stats
    const weeklyStats = await LabTest.aggregate([
      {
        $match: {
          pathologyId: profile._id,
          scheduledDate: { $gte: startOfWeek, $lte: today }
        }
      },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' }
        }
      }
    ]);
    
    // Today's stats
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    
    const todayStats = await LabTest.aggregate([
      {
        $match: {
          pathologyId: profile._id,
          scheduledDate: { $gte: today, $lt: tomorrow }
        }
      },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          pendingTests: {
            $sum: { $cond: [{ $in: ['$status', ['requested', 'scheduled', 'sample_collected', 'processing']] }, 1, 0] }
          },
          completedTests: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          }
        }
      }
    ]);
    
    // Get popular tests
    const popularTests = await LabTest.aggregate([
      { $match: { pathologyId: profile._id } },
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
    
    // Get recent tests
    const recentTests = await LabTest.find({
      pathologyId: profile._id
    })
    .populate('patientId', 'name')
    .populate('doctorId', 'name')
    .sort({ createdAt: -1 })
    .limit(5);
    
    // Get upcoming tests
    const upcomingTests = await LabTest.find({
      pathologyId: profile._id,
      scheduledDate: { $gte: today },
      status: { $in: ['requested', 'scheduled'] }
    })
    .populate('patientId', 'name phone')
    .sort({ scheduledDate: 1 })
    .limit(5);
    
    res.json({
      success: true,
      stats: {
        monthly: monthlyStats[0] || {
          totalTests: 0,
          totalRevenue: 0,
          pendingTests: 0,
          completedTests: 0
        },
        weekly: weeklyStats[0] || {
          totalTests: 0,
          totalRevenue: 0
        },
        today: todayStats[0] || {
          totalTests: 0,
          pendingTests: 0,
          completedTests: 0
        }
      },
      popularTests,
      profile: {
        labName: profile.labName,
        averageRating: profile.averageRating || 0,
        totalTestsConducted: profile.totalTestsConducted || 0,
        totalRevenue: profile.totalRevenue || 0,
        homeCollectionAvailable: profile.homeCollectionAvailable || false
      },
      recentTests,
      upcomingTests
    });
  } catch (error) {
    console.error('Error fetching pathology dashboard:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
};