const PathologyProfile = require('../models/PathologyProfile');
const LabTest = require('../models/LabTest');

const normalizeEmail = (v) => (v ? String(v).trim().toLowerCase() : '');
const normalizePhone = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const sanitizeCoords = (coords) => {
  if (!Array.isArray(coords) || coords.length !== 2) return [0, 0];
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (Number.isNaN(lng) || Number.isNaN(lat)) return [0, 0];
  return [lng, lat];
};

const sanitizeServices = (services) => {
  if (!Array.isArray(services)) return [];
  return services
    .map((s) => ({
      testCode: s.testCode ? String(s.testCode).trim() : undefined,
      testName: s.testName ? String(s.testName).trim() : undefined,
      description: s.description ? String(s.description).trim() : undefined,
      price: s.price !== undefined && s.price !== null ? Number(s.price) : undefined,
      fastingRequired: s.fastingRequired === true,
      reportTime: s.reportTime !== undefined && s.reportTime !== null ? Number(s.reportTime) : undefined,
      sampleType: s.sampleType ? String(s.sampleType).trim() : undefined
    }))
    .filter((s) => s.testName && Number.isFinite(s.price)); // minimum needed
};

// ========== PATHOLOGY-ONLY FUNCTIONS ==========

// ✅ Create pathology profile (needed for your ProfileCompletionModal)
exports.createProfile = async (req, res) => {
  try {
    const { labName, phone, email, address, services } = req.body || {};

    if (!labName?.trim()) {
      return res.status(400).json({ success: false, error: 'labName is required' });
    }
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      return res.status(400).json({ success: false, error: 'phone is required' });
    }

    const existing = await PathologyProfile.findOne({ userId: req.user.id });
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Profile already exists. Use update profile instead.'
      });
    }

    const profile = new PathologyProfile({
      userId: req.user.id,
      labName: labName.trim(),
      phone: cleanPhone,
      email: normalizeEmail(email) || req.user.email || undefined,
      address: {
        street: address?.street || '',
        city: address?.city || '',
        state: address?.state || '',
        pincode: address?.pincode || '',
        location: {
          type: 'Point',
          coordinates: sanitizeCoords(address?.location?.coordinates)
        }
      },
      services: sanitizeServices(services),
      verificationStatus: 'pending'
    });

    // File uploads (optional)
    if (req.files?.profileImage?.[0]?.path) {
      profile.profileImage = req.files.profileImage[0].path;
    }

    await profile.save();

    return res.status(201).json({
      success: true,
      message: 'Pathology profile created successfully',
      profile
    });
  } catch (error) {
    console.error('Error creating pathology profile:', error.message);

    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Profile already exists for this user'
      });
    }

    return res.status(400).json({ success: false, error: error.message });
  }
};

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
    const updates = { ...(req.body || {}) };

    // ❌ Disallow self-updating protected/statistical/admin fields
    delete updates.userId;
    delete updates.verificationStatus;
    delete updates.adminNotes;
    delete updates.verifiedAt;
    delete updates.verifiedBy;

    delete updates.totalTestsConducted;
    delete updates.averageRating;
    delete updates.totalReviews;
    delete updates.commissionRate;

    // Normalize
    if (updates.email) updates.email = normalizeEmail(updates.email);
    if (updates.phone) updates.phone = normalizePhone(updates.phone);

    // Validate services shape if provided
    if (updates.services) {
      updates.services = sanitizeServices(updates.services);
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found'
      });
    }

    // Build safe $set (avoid overwriting nested address accidentally)
    const $set = {};

    // Simple top-level fields
    const allowedTop = [
      'labName',
      'registrationNumber',
      'contactPerson',
      'phone',
      'email',
      'website',
      'services',
      'homeCollectionAvailable',
      'homeCollectionCharges',
      'operatingHours',
      'accreditation',
      'licenses'
    ];

    for (const key of allowedTop) {
      if (updates[key] !== undefined) $set[key] = updates[key];
    }

    // Address merge
    if (updates.address) {
      if (updates.address.street !== undefined) $set['address.street'] = updates.address.street;
      if (updates.address.city !== undefined) $set['address.city'] = updates.address.city;
      if (updates.address.state !== undefined) $set['address.state'] = updates.address.state;
      if (updates.address.pincode !== undefined) $set['address.pincode'] = updates.address.pincode;

      if (updates.address.location?.coordinates) {
        $set['address.location.type'] = 'Point';
        $set['address.location.coordinates'] = sanitizeCoords(updates.address.location.coordinates);
      }
    }

    // File upload (optional)
    if (req.files?.profileImage?.[0]?.path) {
      $set.profileImage = req.files.profileImage[0].path;
    }

    const updatedProfile = await PathologyProfile.findByIdAndUpdate(
      profile._id,
      { $set },
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

    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .select('testSlots labName homeCollectionAvailable');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    let slots = [];

    const mapSlots = (slotDoc) => ({
      date: slotDoc.date,
      timeSlots: slotDoc.timeSlots.map((ts) => ({
        ...ts.toObject(),
        availableCapacity: (ts.maxCapacity || 0) - (ts.bookedCount || 0)
      }))
    });

    if (date) {
      const selectedDate = startOfDay(date);

      const daySlots = profile.testSlots.find((s) => startOfDay(s.date).getTime() === selectedDate.getTime());
      if (daySlots) slots = [mapSlots(daySlots)];
    } else if (startDate && endDate) {
      const start = startOfDay(startDate);
      const end = endOfDay(endDate);

      slots = profile.testSlots
        .filter((s) => new Date(s.date) >= start && new Date(s.date) <= end)
        .map(mapSlots)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    } else {
      const today = startOfDay(new Date());
      const nextWeek = endOfDay(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000));

      slots = profile.testSlots
        .filter((s) => new Date(s.date) >= today && new Date(s.date) <= nextWeek)
        .map(mapSlots)
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
    res.status(500).json({ success: false, error: 'Failed to fetch test slots' });
  }
};

// Update current pathology's test slots for specific date
exports.updateTestSlots = async (req, res) => {
  try {
    const { date, timeSlots } = req.body || {};

    if (!date || !Array.isArray(timeSlots)) {
      return res.status(400).json({ success: false, error: 'Date and timeSlots array are required' });
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const slotDate = startOfDay(date);

    // Find existing slot day
    const existingIndex = profile.testSlots.findIndex(
      (s) => startOfDay(s.date).getTime() === slotDate.getTime()
    );

    const existingTimeSlots = existingIndex >= 0 ? profile.testSlots[existingIndex].timeSlots : [];
    const existingMap = new Map();
    existingTimeSlots.forEach((ts) => {
      existingMap.set(`${ts.startTime}-${ts.endTime}`, ts);
    });

    // Validate + preserve bookedCount if not sent
    const seen = new Set();
    const validated = timeSlots.map((slot) => {
      if (!slot.startTime || !slot.endTime) {
        throw new Error('Each time slot must have startTime and endTime');
      }

      const key = `${slot.startTime}-${slot.endTime}`;
      if (seen.has(key)) throw new Error(`Duplicate time slot: ${key}`);
      seen.add(key);

      const maxCapacity = slot.maxCapacity !== undefined ? parseInt(slot.maxCapacity, 10) : 10;
      if (!Number.isFinite(maxCapacity) || maxCapacity <= 0) {
        throw new Error(`Invalid maxCapacity for slot ${key}`);
      }

      const prev = existingMap.get(key);
      const bookedCount =
        slot.bookedCount !== undefined
          ? parseInt(slot.bookedCount, 10) || 0
          : (prev?.bookedCount || 0);

      if (bookedCount > maxCapacity) {
        throw new Error(
          `Cannot set capacity ${maxCapacity} for ${key}. ${bookedCount} already booked.`
        );
      }

      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        maxCapacity,
        bookedCount,
        isAvailable: slot.isAvailable !== false
      };
    });

    if (existingIndex >= 0) {
      // also ensure you didn't remove a slot that has bookings (optional strict rule)
      for (const prev of existingTimeSlots) {
        const prevKey = `${prev.startTime}-${prev.endTime}`;
        if (!seen.has(prevKey) && (prev.bookedCount || 0) > 0) {
          return res.status(400).json({
            success: false,
            error: `Cannot remove slot ${prevKey}. ${(prev.bookedCount || 0)} already booked.`
          });
        }
      }

      profile.testSlots[existingIndex].timeSlots = validated;
    } else {
      profile.testSlots.push({ date: slotDate, timeSlots: validated });
    }

    profile.testSlots.sort((a, b) => new Date(a.date) - new Date(b.date));
    await profile.save();

    res.json({
      success: true,
      message: 'Test slots updated successfully',
      date: slotDate,
      timeSlots: validated
    });
  } catch (error) {
    console.error('Error updating test slots:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
};

// Bulk update test slots for multiple dates
exports.bulkUpdateTestSlots = async (req, res) => {
  try {
    const { slots } = req.body || {};

    if (!Array.isArray(slots)) {
      return res.status(400).json({ success: false, error: 'Slots array is required' });
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const updatedSlots = [];
    const errors = [];

    for (const slotData of slots) {
      try {
        const { date, timeSlots } = slotData || {};
        if (!date || !Array.isArray(timeSlots)) {
          errors.push({ date, error: 'Invalid slot data' });
          continue;
        }

        // Reuse single-date logic by calling our validator behavior
        const slotDate = startOfDay(date);

        const existingIndex = profile.testSlots.findIndex(
          (s) => startOfDay(s.date).getTime() === slotDate.getTime()
        );

        const existingTimeSlots = existingIndex >= 0 ? profile.testSlots[existingIndex].timeSlots : [];
        const existingMap = new Map();
        existingTimeSlots.forEach((ts) => existingMap.set(`${ts.startTime}-${ts.endTime}`, ts));

        const seen = new Set();
        const validated = timeSlots.map((slot) => {
          if (!slot.startTime || !slot.endTime) throw new Error('Each time slot must have startTime and endTime');

          const key = `${slot.startTime}-${slot.endTime}`;
          if (seen.has(key)) throw new Error(`Duplicate time slot: ${key}`);
          seen.add(key);

          const maxCapacity = slot.maxCapacity !== undefined ? parseInt(slot.maxCapacity, 10) : 10;
          const prev = existingMap.get(key);
          const bookedCount =
            slot.bookedCount !== undefined
              ? parseInt(slot.bookedCount, 10) || 0
              : (prev?.bookedCount || 0);

          if (bookedCount > maxCapacity) {
            throw new Error(`Cannot set capacity ${maxCapacity} for ${key}. ${bookedCount} already booked.`);
          }

          return {
            startTime: slot.startTime,
            endTime: slot.endTime,
            maxCapacity,
            bookedCount,
            isAvailable: slot.isAvailable !== false
          };
        });

        if (existingIndex >= 0) {
          profile.testSlots[existingIndex].timeSlots = validated;
        } else {
          profile.testSlots.push({ date: slotDate, timeSlots: validated });
        }

        updatedSlots.push(slotDate.toISOString().split('T')[0]);
      } catch (slotError) {
        errors.push({ date: slotData?.date, error: slotError.message });
      }
    }

    profile.testSlots.sort((a, b) => new Date(a.date) - new Date(b.date));
    await profile.save();

    res.json({
      success: true,
      message: `Updated ${updatedSlots.length} date(s) successfully`,
      updatedSlots,
      errors: errors.length ? errors : undefined
    });
  } catch (error) {
    console.error('Error in bulk update test slots:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
};

// Get current pathology's lab tests
exports.getLabTests = async (req, res) => {
  try {
    const { status, type, startDate, endDate, page = 1, limit = 20 } = req.query;

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = { pathologyId: profile._id };
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.scheduledDate = { $gte: new Date(startDate), $lte: new Date(endDate) };
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

    const today = startOfDay(new Date());
    const tomorrow = startOfDay(new Date(today.getTime() + 24 * 60 * 60 * 1000));

    const todaysTests = await LabTest.countDocuments({
      pathologyId: profile._id,
      scheduledDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['scheduled', 'sample_collected'] }
    });

    const stats = await LabTest.aggregate([
      { $match: { pathologyId: profile._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
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
    res.status(500).json({ success: false, error: 'Failed to fetch lab tests' });
  }
};

// Get specific lab test by ID
exports.getLabTestById = async (req, res) => {
  try {
    const { id } = req.params;

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const labTest = await LabTest.findOne({ _id: id, pathologyId: profile._id })
      .populate('patientId', 'name phone age gender bloodGroup address')
      .populate('doctorId', 'name specialization clinicAddress')
      .populate('appointmentId', 'appointmentDate type')
      .populate('prescriptionId', 'diagnosis medicines');

    if (!labTest) return res.status(404).json({ success: false, error: 'Lab test not found' });

    res.json({ success: true, labTest });
  } catch (error) {
    console.error('Error fetching lab test:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch lab test' });
  }
};

// Update lab test status
exports.updateTestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, sampleCollectedAt, sampleCollectedBy } = req.body || {};

    if (!status) return res.status(400).json({ success: false, error: 'Status is required' });

    const validStatuses = ['requested', 'scheduled', 'sample_collected', 'processing', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const updateData = { status };

    if (status === 'sample_collected') {
      updateData.sampleCollectedAt = sampleCollectedAt ? new Date(sampleCollectedAt) : new Date();
      updateData.sampleCollectedBy = sampleCollectedBy || req.user.name || 'Staff';
    }

    if (status === 'completed') {
      updateData.completedAt = new Date();
    }

    const labTest = await LabTest.findOneAndUpdate(
      { _id: id, pathologyId: profile._id },
      updateData,
      { new: true, runValidators: true }
    );

    if (!labTest) return res.status(404).json({ success: false, error: 'Lab test not found' });

    res.json({ success: true, message: 'Test status updated successfully', labTest });
  } catch (error) {
    console.error('Error updating test status:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
};

// Upload test report
exports.uploadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { reportUrl, findings, remarks } = req.body || {};

    if (!reportUrl) {
      return res.status(400).json({ success: false, error: 'Report URL is required' });
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    // Read current status to avoid double-counting totalTestsConducted
    const current = await LabTest.findOne({ _id: id, pathologyId: profile._id }).select('status');
    if (!current) return res.status(404).json({ success: false, error: 'Lab test not found' });

    const wasCompleted = current.status === 'completed';

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

    if (!wasCompleted) {
      await PathologyProfile.findByIdAndUpdate(profile._id, { $inc: { totalTestsConducted: 1 } });
    }

    res.json({ success: true, message: 'Report uploaded successfully', labTest });
  } catch (error) {
    console.error('Error uploading report:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
};

// Get current pathology's dashboard stats
exports.getDashboardStats = async (req, res) => {
  try {
    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .select('labName averageRating totalTestsConducted homeCollectionAvailable');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const today = startOfDay(new Date());
    const tomorrow = startOfDay(new Date(today.getTime() + 24 * 60 * 60 * 1000));
    const startOfMonth = startOfDay(new Date(today.getFullYear(), today.getMonth(), 1));

    const startOfWeek = startOfDay(new Date(today));
    startOfWeek.setDate(today.getDate() - today.getDay());

    const monthlyStats = await LabTest.aggregate([
      { $match: { pathologyId: profile._id, createdAt: { $gte: startOfMonth } } },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' },
          pendingTests: {
            $sum: {
              $cond: [{ $in: ['$status', ['requested', 'scheduled', 'sample_collected', 'processing']] }, 1, 0]
            }
          },
          completedTests: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
        }
      }
    ]);

    const weeklyStats = await LabTest.aggregate([
      { $match: { pathologyId: profile._id, scheduledDate: { $gte: startOfWeek, $lt: tomorrow } } },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' }
        }
      }
    ]);

    const todayStats = await LabTest.aggregate([
      { $match: { pathologyId: profile._id, scheduledDate: { $gte: today, $lt: tomorrow } } },
      {
        $group: {
          _id: null,
          totalTests: { $sum: 1 },
          totalRevenue: { $sum: '$totalAmount' },
          pendingTests: {
            $sum: {
              $cond: [{ $in: ['$status', ['requested', 'scheduled', 'sample_collected', 'processing']] }, 1, 0]
            }
          },
          completedTests: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
        }
      }
    ]);

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

    const recentTests = await LabTest.find({ pathologyId: profile._id })
      .populate('patientId', 'name')
      .populate('doctorId', 'name')
      .sort({ createdAt: -1 })
      .limit(5);

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
        monthly: monthlyStats[0] || { totalTests: 0, totalRevenue: 0, pendingTests: 0, completedTests: 0 },
        weekly: weeklyStats[0] || { totalTests: 0, totalRevenue: 0 },
        today: todayStats[0] || { totalTests: 0, totalRevenue: 0, pendingTests: 0, completedTests: 0 }
      },
      popularTests,
      profile: {
        labName: profile.labName,
        averageRating: profile.averageRating || 0,
        totalTestsConducted: profile.totalTestsConducted || 0,
        homeCollectionAvailable: profile.homeCollectionAvailable || false
      },
      recentTests,
      upcomingTests
    });
  } catch (error) {
    console.error('Error fetching pathology dashboard:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
};
