const mongoose = require('mongoose');

const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const PathologyProfile = require('../models/PathologyProfile');
const LabTest = require('../models/LabTest');
const User = require('../models/User');
const PatientProfile = require('../models/PatientProfile');

const { initializeCalendarForMonth } = require('../jobs/calendarJob');

// ===================== helpers =====================
const normalizeEmail = (v) => (v ? String(v).trim().toLowerCase() : '');
const normalizePhone = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

const pad2 = (n) => String(n).padStart(2, '0');
const dateKeyLocal = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
};

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
    .filter((s) => s.testName && Number.isFinite(s.price));
};

const ensureCalendarMonth = async (year, month) => {
  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) {
    calendar = await initializeCalendarForMonth(year, month);
  }
  return calendar;
};

const upsertPathologyDayInCalendar = async ({
  calendar,
  targetDay,
  pathologyProfileId,
  workingHours,
  session
}) => {
  const key = dateKeyLocal(targetDay);
  let day = calendar.days.find((d) => dateKeyLocal(d.date) === key);

  if (!day) {
    const dayName = targetDay.toLocaleDateString('en-US', { weekday: 'long' });
    calendar.days.push({
      date: targetDay,
      dayName,
      isHoliday: false,
      professionals: []
    });

    calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
    day = calendar.days.find((d) => dateKeyLocal(d.date) === key);
  }

  let prof = day.professionals.find(
    (p) =>
      String(p.professionalId) === String(pathologyProfileId) &&
      p.professionalType === 'pathology'
  );

  if (!prof) {
    prof = {
      professionalId: pathologyProfileId,
      professionalType: 'pathology',
      bookedSlots: [],
      breaks: [],
      workingHours: workingHours || [],
      isAvailable: (workingHours || []).length > 0
    };
    day.professionals.push(prof);
  } else {
    prof.workingHours = workingHours || [];
    prof.isAvailable = (workingHours || []).length > 0;
  }

  calendar.markModified('days');
  await calendar.save(session ? { session } : undefined);

  return { day, prof };
};

const mapSlotsForResponse = (slotDoc) => ({
  date: slotDoc.date,
  timeSlots: (slotDoc.timeSlots || []).map((ts) => {
    const max = ts.maxCapacity || 0;
    const booked = ts.bookedCount || 0;
    const remaining = max - booked;
    return {
      startTime: ts.startTime,
      endTime: ts.endTime,
      maxCapacity: max,
      bookedCount: booked,
      availableCapacity: remaining,
      isAvailable: ts.isAvailable !== false && remaining > 0
    };
  })
});

// Simple status transitions for pathology appointments
const isValidAppointmentStatus = (status) => {
  const allowed = [
    'pending',
    'confirmed',
    'accepted',
    'rejected',
    'rescheduled',
    'cancelled',
    'completed',
    'no_show',
    'in_progress'
  ];
  return allowed.includes(status);
};

// ===================== PUBLIC (patients) =====================

// GET /pathology
exports.getAllLabs = async (req, res) => {
  try {
    const { page = 1, limit = 20, city, search, homeCollectionAvailable } = req.query;

    const filter = { verificationStatus: 'approved' };

    if (city) filter['address.city'] = { $regex: city, $options: 'i' };

    if (homeCollectionAvailable !== undefined) {
      filter.homeCollectionAvailable = String(homeCollectionAvailable) === 'true';
    }

    if (search) {
      filter.$or = [
        { labName: { $regex: search, $options: 'i' } },
        { 'services.testName': { $regex: search, $options: 'i' } },
        { 'services.testCode': { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const labs = await PathologyProfile.find(filter)
      .select(
        'labName profileImage phone email address homeCollectionAvailable homeCollectionCharges accreditation averageRating totalReviews services operatingHours'
      )
      .sort({ averageRating: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await PathologyProfile.countDocuments(filter);

    return res.json({
      success: true,
      labs,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (error) {
    console.error('Error fetching labs:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch labs' });
  }
};

// GET /pathology/:id
exports.getLabById = async (req, res) => {
  try {
    const lab = await PathologyProfile.findById(req.params.id).select(
      'labName profileImage phone email website address homeCollectionAvailable homeCollectionCharges accreditation licenses operatingHours services averageRating totalReviews verificationStatus'
    );

    if (!lab) return res.status(404).json({ success: false, error: 'Lab not found' });
    if (lab.verificationStatus !== 'approved') {
      return res.status(400).json({ success: false, error: 'Lab is not approved' });
    }

    return res.json({ success: true, lab });
  } catch (error) {
    console.error('Error fetching lab:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch lab' });
  }
};

// GET /pathology/search/tests?query=cbc
exports.searchTests = async (req, res) => {
  try {
    const { query, page = 1, limit = 20, city } = req.query;
    if (!query) return res.status(400).json({ success: false, error: 'query is required' });

    const filter = {
      verificationStatus: 'approved',
      $text: { $search: query }
    };
    if (city) filter['address.city'] = { $regex: city, $options: 'i' };

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const labs = await PathologyProfile.find(filter, { score: { $meta: 'textScore' } })
      .select('labName address services homeCollectionAvailable homeCollectionCharges averageRating')
      .sort({ score: { $meta: 'textScore' } })
      .skip(skip)
      .limit(parseInt(limit, 10));

    return res.json({ success: true, query, labs });
  } catch (error) {
    console.error('Error searching tests:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to search tests' });
  }
};

// GET /pathology/:id/test-slots
exports.getPublicTestSlots = async (req, res) => {
  try {
    const { id } = req.params;
    const { date, startDate, endDate } = req.query;

    const lab = await PathologyProfile.findById(id).select(
      'labName testSlots homeCollectionAvailable homeCollectionCharges verificationStatus operatingHours'
    );

    if (!lab) return res.status(404).json({ success: false, error: 'Lab not found' });
    if (lab.verificationStatus !== 'approved') {
      return res.status(400).json({ success: false, error: 'Lab is not approved' });
    }

    const isHoliday = (d) => {
      const key = dateKeyLocal(d);
      const holidays = (lab.operatingHours?.holidays || []).map(dateKeyLocal);
      return holidays.includes(key);
    };

    let slots = [];

    if (date) {
      const targetDay = startOfDay(new Date(date));
      if (isHoliday(targetDay)) {
        return res.json({
          success: true,
          labName: lab.labName,
          homeCollectionAvailable: lab.homeCollectionAvailable,
          homeCollectionCharges: lab.homeCollectionCharges || 0,
          slots: [],
          isHoliday: true
        });
      }

      const found = (lab.testSlots || []).find((s) => dateKeyLocal(s.date) === dateKeyLocal(targetDay));
      if (found) slots = [mapSlotsForResponse(found)];
    } else if (startDate && endDate) {
      const start = startOfDay(new Date(startDate));
      const end = endOfDay(new Date(endDate));

      slots = (lab.testSlots || [])
        .filter((s) => new Date(s.date) >= start && new Date(s.date) <= end)
        .filter((s) => !isHoliday(s.date))
        .map(mapSlotsForResponse)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    } else {
      const today = startOfDay(new Date());
      const nextWeek = endOfDay(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000));

      slots = (lab.testSlots || [])
        .filter((s) => new Date(s.date) >= today && new Date(s.date) <= nextWeek)
        .filter((s) => !isHoliday(s.date))
        .map(mapSlotsForResponse)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    return res.json({
      success: true,
      labName: lab.labName,
      homeCollectionAvailable: lab.homeCollectionAvailable,
      homeCollectionCharges: lab.homeCollectionCharges || 0,
      slots,
      count: slots.length
    });
  } catch (error) {
    console.error('Error fetching public test slots:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch test slots' });
  }
};

// POST /pathology/:id/book
// body: { date, startTime, endTime, tests[], type:'lab'|'home', notes? }
exports.bookTestSlot = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { id } = req.params; // pathologyProfileId
    const { date, startTime, endTime, tests, type = 'lab', notes } = req.body || {};

    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'date, startTime, endTime are required' });
    }

    // patient identity
    let patientProfileId = req.body?.patientId;
    if (req.user.role === 'patient') {
      const patient = await PatientProfile.findOne({ userId: req.user.id }).select('_id');
      if (!patient) return res.status(404).json({ success: false, error: 'Patient profile not found' });
      patientProfileId = patient._id;
    } else if (!patientProfileId) {
      return res.status(400).json({ success: false, error: 'patientId is required for admin booking' });
    }

    const targetDay = startOfDay(new Date(date));
    if (Number.isNaN(targetDay.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }

    const today = startOfDay(new Date());
    if (targetDay < today) {
      return res.status(400).json({ success: false, error: 'Cannot book past dates' });
    }

    // lab
    const lab = await PathologyProfile.findById(id).select(
      'labName verificationStatus homeCollectionAvailable homeCollectionCharges services testSlots operatingHours'
    );
    if (!lab) return res.status(404).json({ success: false, error: 'Lab not found' });
    if (lab.verificationStatus !== 'approved') {
      return res.status(400).json({ success: false, error: 'Lab is not approved' });
    }

    const holidayKeys = (lab.operatingHours?.holidays || []).map(dateKeyLocal);
    if (holidayKeys.includes(dateKeyLocal(targetDay))) {
      return res.status(400).json({ success: false, error: 'Lab is closed on selected date (holiday)' });
    }

    if (type === 'home' && !lab.homeCollectionAvailable) {
      return res.status(400).json({ success: false, error: 'Home collection not available' });
    }

    // pricing (optional)
    const selectedTests = Array.isArray(tests) ? tests : [];
    const serviceMap = new Map((lab.services || []).map((s) => [String(s.testCode || s.testName), s]));

    const normalizedTests = selectedTests
      .map((t) => {
        const key = String(t.testCode || t.testName || '').trim();
        const svc = serviceMap.get(key);
        return {
          testCode: t.testCode || svc?.testCode,
          testName: t.testName || svc?.testName || key,
          price: Number.isFinite(Number(t.price)) ? Number(t.price) : (svc?.price || 0),
          fastingRequired: t.fastingRequired === true || svc?.fastingRequired === true,
          sampleType: t.sampleType || svc?.sampleType,
          reportTime: Number.isFinite(Number(t.reportTime)) ? Number(t.reportTime) : svc?.reportTime
        };
      })
      .filter((t) => t.testName);

    const testsTotal = normalizedTests.reduce((sum, t) => sum + (Number(t.price) || 0), 0);
    const homeFee = type === 'home' ? (lab.homeCollectionCharges || 0) : 0;
    const totalAmount = testsTotal + homeFee;

    const year = targetDay.getFullYear();
    const month = targetDay.getMonth() + 1;
    await ensureCalendarMonth(year, month);

    let appointmentDoc;
    let labTestDoc;

    await session.withTransaction(async () => {
      // 1) capacity update on PathologyProfile.testSlots
      const profileTxn = await PathologyProfile.findById(id).session(session);
      if (!profileTxn) throw new Error('Lab not found');

      const daySlot = (profileTxn.testSlots || []).find((s) => dateKeyLocal(s.date) === dateKeyLocal(targetDay));
      if (!daySlot) throw new Error('No slots configured for selected date');

      const timeSlot = (daySlot.timeSlots || []).find(
        (ts) => ts.startTime === startTime && ts.endTime === endTime
      );
      if (!timeSlot) throw new Error('Selected time slot not found');

      const max = timeSlot.maxCapacity || 0;
      const booked = timeSlot.bookedCount || 0;
      if (timeSlot.isAvailable === false) throw new Error('Selected slot not available');
      if (booked >= max) throw new Error('Selected slot is full');

      timeSlot.bookedCount = booked + 1;
      if (timeSlot.bookedCount >= max) timeSlot.isAvailable = false;

      profileTxn.markModified('testSlots');
      await profileTxn.save({ session });

      // 2) create Appointment (updated schema fields)
      const appt = await Appointment.create(
        [
          {
            professionalType: 'pathology',
            pathologyId: profileTxn._id,
            patientId: patientProfileId,
            appointmentDate: targetDay,
            startTime,
            endTime,
            type, // lab | home
            status: 'confirmed',
            totalAmount,
            notes: notes || ''
          }
        ],
        { session }
      );
      appointmentDoc = appt[0];

      // 3) create LabTest linked to appointment
      const lt = await LabTest.create(
        [
          {
            pathologyId: profileTxn._id,
            patientId: patientProfileId,
            appointmentId: appointmentDoc._id,
            scheduledDate: targetDay,
            startTime,
            endTime,
            type, // lab | home
            tests: normalizedTests,
            totalAmount,
            collectionCharges: homeFee,
            status: 'scheduled',
            notes: notes || ''
          }
        ],
        { session }
      );
      labTestDoc = lt[0];

      // 4) write reference booking into Calendar
      const calTxn = await Calendar.findOne({ year, month }).session(session);
      if (!calTxn) throw new Error('Calendar not found');

      const workingHours = (daySlot.timeSlots || [])
        .filter((s) => s.isAvailable !== false)
        .map((s) => ({ startTime: s.startTime, endTime: s.endTime }));

      const { prof } = await upsertPathologyDayInCalendar({
        calendar: calTxn,
        targetDay,
        pathologyProfileId: profileTxn._id,
        workingHours,
        session
      });

      prof.bookedSlots = prof.bookedSlots || [];
      prof.bookedSlots.push({
        appointmentId: appointmentDoc._id,
        patientId: patientProfileId,
        startTime,
        endTime,
        bookedAt: new Date(),
        bookedBy: req.user.id,
        status: 'booked'
      });

      calTxn.markModified('days');
      await calTxn.save({ session });
    });

    return res.status(201).json({
      success: true,
      message: 'Test slot booked successfully',
      booking: {
        appointmentId: appointmentDoc?._id,
        labTestId: labTestDoc?._id,
        labId: id,
        labName: lab.labName,
        date: dateKeyLocal(targetDay),
        startTime,
        endTime,
        type,
        totalAmount
      }
    });
  } catch (error) {
    console.error('Error booking test slot:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  } finally {
    session.endSession();
  }
};

// ===================== PATHOLOGY (/me) =====================

// POST /pathology/me/profile
exports.createProfile = async (req, res) => {
  try {
    const { labName, phone, email, address, services } = req.body || {};

    if (!labName?.trim()) return res.status(400).json({ success: false, error: 'labName is required' });

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return res.status(400).json({ success: false, error: 'phone is required' });

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

    if (req.files?.profileImage?.[0]?.path) profile.profileImage = req.files.profileImage[0].path;

    await profile.save();
    await User.findByIdAndUpdate(req.user.id, { profileId: profile._id });

    return res.status(201).json({ success: true, message: 'Pathology profile created successfully', profile });
  } catch (error) {
    console.error('Error creating pathology profile:', error.message);
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, error: 'Profile already exists for this user' });
    }
    return res.status(400).json({ success: false, error: error.message });
  }
};

// GET /pathology/me/profile
exports.getProfile = async (req, res) => {
  try {
    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .populate('userId', 'email isVerified lastLogin');

    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    return res.json({ success: true, profile });
  } catch (error) {
    console.error('Error fetching pathology profile:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
};

// PUT /pathology/me/profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };

    delete updates.userId;
    delete updates.verificationStatus;
    delete updates.adminNotes;
    delete updates.verifiedAt;
    delete updates.verifiedBy;
    delete updates.totalTestsConducted;
    delete updates.averageRating;
    delete updates.totalReviews;
    delete updates.commissionRate;

    if (updates.email) updates.email = normalizeEmail(updates.email);
    if (updates.phone) updates.phone = normalizePhone(updates.phone);
    if (updates.services) updates.services = sanitizeServices(updates.services);

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const $set = {};
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

    if (req.files?.profileImage?.[0]?.path) $set.profileImage = req.files.profileImage[0].path;

    const updatedProfile = await PathologyProfile.findByIdAndUpdate(
      profile._id,
      { $set },
      { new: true, runValidators: true }
    );

    return res.json({ success: true, message: 'Profile updated successfully', profile: updatedProfile });
  } catch (error) {
    console.error('Error updating pathology profile:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

// GET /pathology/me/test-slots
exports.getTestSlots = async (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;

    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .select('testSlots labName homeCollectionAvailable homeCollectionCharges');

    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    let slots = [];

    if (date) {
      const targetDay = startOfDay(new Date(date));
      const found = (profile.testSlots || []).find((s) => dateKeyLocal(s.date) === dateKeyLocal(targetDay));
      if (found) slots = [mapSlotsForResponse(found)];
    } else if (startDate && endDate) {
      const start = startOfDay(new Date(startDate));
      const end = endOfDay(new Date(endDate));
      slots = (profile.testSlots || [])
        .filter((s) => new Date(s.date) >= start && new Date(s.date) <= end)
        .map(mapSlotsForResponse)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    } else {
      const today = startOfDay(new Date());
      const nextWeek = endOfDay(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000));
      slots = (profile.testSlots || [])
        .filter((s) => new Date(s.date) >= today && new Date(s.date) <= nextWeek)
        .map(mapSlotsForResponse)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    return res.json({
      success: true,
      labName: profile.labName,
      homeCollectionAvailable: profile.homeCollectionAvailable,
      homeCollectionCharges: profile.homeCollectionCharges || 0,
      slots,
      count: slots.length
    });
  } catch (error) {
    console.error('Error fetching test slots:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch test slots' });
  }
};

// PUT /pathology/me/test-slots
exports.updateTestSlots = async (req, res) => {
  try {
    const { date, timeSlots } = req.body || {};
    if (!date || !Array.isArray(timeSlots)) {
      return res.status(400).json({ success: false, error: 'Date and timeSlots array are required' });
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const targetDay = startOfDay(new Date(date));
    const key = dateKeyLocal(targetDay);

    let idx = (profile.testSlots || []).findIndex((s) => dateKeyLocal(s.date) === key);
    const prevSlots = idx >= 0 ? (profile.testSlots[idx].timeSlots || []) : [];

    const prevMap = new Map(prevSlots.map((s) => [`${s.startTime}-${s.endTime}`, s]));
    const seen = new Set();

    const validated = timeSlots.map((slot) => {
      if (!slot.startTime || !slot.endTime) throw new Error('Each time slot must have startTime and endTime');

      const k = `${slot.startTime}-${slot.endTime}`;
      if (seen.has(k)) throw new Error(`Duplicate time slot: ${k}`);
      seen.add(k);

      const maxCapacity = slot.maxCapacity !== undefined ? parseInt(slot.maxCapacity, 10) : 10;
      if (!Number.isFinite(maxCapacity) || maxCapacity <= 0) throw new Error(`Invalid maxCapacity for slot ${k}`);

      const prev = prevMap.get(k);
      const bookedCount =
        slot.bookedCount !== undefined ? (parseInt(slot.bookedCount, 10) || 0) : (prev?.bookedCount || 0);

      if (bookedCount > maxCapacity) {
        throw new Error(`Cannot set capacity ${maxCapacity} for ${k}. ${bookedCount} already booked.`);
      }

      return {
        startTime: slot.startTime,
        endTime: slot.endTime,
        maxCapacity,
        bookedCount,
        isAvailable: slot.isAvailable !== false
      };
    });

    for (const prev of prevSlots) {
      const k = `${prev.startTime}-${prev.endTime}`;
      if (!seen.has(k) && (prev.bookedCount || 0) > 0) {
        return res.status(400).json({
          success: false,
          error: `Cannot remove slot ${k}. ${(prev.bookedCount || 0)} already booked.`
        });
      }
    }

    if (idx >= 0) profile.testSlots[idx].timeSlots = validated;
    else profile.testSlots.push({ date: targetDay, timeSlots: validated });

    profile.testSlots.sort((a, b) => new Date(a.date) - new Date(b.date));
    await profile.save();

    const year = targetDay.getFullYear();
    const month = targetDay.getMonth() + 1;
    const calendar = await ensureCalendarMonth(year, month);

    const workingHours = validated
      .filter((s) => s.isAvailable !== false)
      .map((s) => ({ startTime: s.startTime, endTime: s.endTime }));

    await upsertPathologyDayInCalendar({
      calendar,
      targetDay,
      pathologyProfileId: profile._id,
      workingHours
    });

    return res.json({
      success: true,
      message: 'Test slots updated successfully',
      date: key,
      timeSlots: validated
    });
  } catch (error) {
    console.error('Error updating test slots:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

// POST /pathology/me/test-slots/bulk
exports.bulkUpdateTestSlots = async (req, res) => {
  try {
    const { slots } = req.body || {};
    if (!Array.isArray(slots)) return res.status(400).json({ success: false, error: 'Slots array is required' });

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const updatedSlots = [];
    const errors = [];

    for (const slotData of slots) {
      try {
        const { date, timeSlots } = slotData || {};
        if (!date || !Array.isArray(timeSlots)) throw new Error('Invalid slot data');

        const targetDay = startOfDay(new Date(date));
        const key = dateKeyLocal(targetDay);

        let idx = (profile.testSlots || []).findIndex((s) => dateKeyLocal(s.date) === key);
        const prevSlots = idx >= 0 ? (profile.testSlots[idx].timeSlots || []) : [];
        const prevMap = new Map(prevSlots.map((s) => [`${s.startTime}-${s.endTime}`, s]));
        const seen = new Set();

        const validated = timeSlots.map((slot) => {
          if (!slot.startTime || !slot.endTime) throw new Error('Each time slot must have startTime and endTime');

          const k = `${slot.startTime}-${slot.endTime}`;
          if (seen.has(k)) throw new Error(`Duplicate time slot: ${k}`);
          seen.add(k);

          const maxCapacity = slot.maxCapacity !== undefined ? parseInt(slot.maxCapacity, 10) : 10;
          const prev = prevMap.get(k);

          const bookedCount =
            slot.bookedCount !== undefined ? (parseInt(slot.bookedCount, 10) || 0) : (prev?.bookedCount || 0);

          if (bookedCount > maxCapacity) throw new Error(`Cannot set capacity ${maxCapacity} for ${k}. ${bookedCount} already booked.`);

          return {
            startTime: slot.startTime,
            endTime: slot.endTime,
            maxCapacity,
            bookedCount,
            isAvailable: slot.isAvailable !== false
          };
        });

        for (const prev of prevSlots) {
          const k = `${prev.startTime}-${prev.endTime}`;
          if (!seen.has(k) && (prev.bookedCount || 0) > 0) {
            throw new Error(`Cannot remove slot ${k}. ${(prev.bookedCount || 0)} already booked.`);
          }
        }

        if (idx >= 0) profile.testSlots[idx].timeSlots = validated;
        else profile.testSlots.push({ date: targetDay, timeSlots: validated });

        updatedSlots.push(key);
      } catch (e) {
        errors.push({ date: slotData?.date, error: e.message });
      }
    }

    profile.testSlots.sort((a, b) => new Date(a.date) - new Date(b.date));
    await profile.save();

    for (const d of updatedSlots) {
      const targetDay = startOfDay(new Date(d));
      const year = targetDay.getFullYear();
      const month = targetDay.getMonth() + 1;

      const calendar = await ensureCalendarMonth(year, month);

      const daySlot = (profile.testSlots || []).find((s) => dateKeyLocal(s.date) === dateKeyLocal(targetDay));
      const workingHours = (daySlot?.timeSlots || [])
        .filter((s) => s.isAvailable !== false)
        .map((s) => ({ startTime: s.startTime, endTime: s.endTime }));

      await upsertPathologyDayInCalendar({
        calendar,
        targetDay,
        pathologyProfileId: profile._id,
        workingHours
      });
    }

    return res.json({
      success: true,
      message: `Updated ${updatedSlots.length} date(s) successfully`,
      updatedSlots,
      errors: errors.length ? errors : undefined
    });
  } catch (error) {
    console.error('Error in bulk update test slots:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

// ===================== LAB TESTS (me) =====================

exports.getLabTests = async (req, res) => {
  try {
    const { status, type, startDate, endDate, page = 1, limit = 20 } = req.query;

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = { pathologyId: profile._id };
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) filter.scheduledDate = { $gte: new Date(startDate), $lte: new Date(endDate) };

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const labTests = await LabTest.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('doctorId', 'name specialization')
      .populate('appointmentId', 'appointmentDate type startTime endTime status')
      .sort({ scheduledDate: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await LabTest.countDocuments(filter);

    return res.json({
      success: true,
      labTests,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (error) {
    console.error('Error fetching lab tests:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch lab tests' });
  }
};

exports.getLabTestById = async (req, res) => {
  try {
    const { id } = req.params;

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const labTest = await LabTest.findOne({ _id: id, pathologyId: profile._id })
      .populate('patientId', 'name phone age gender bloodGroup address')
      .populate('doctorId', 'name specialization clinicAddress')
      .populate('appointmentId', 'appointmentDate type startTime endTime status')
      .populate('prescriptionId', 'diagnosis medicines');

    if (!labTest) return res.status(404).json({ success: false, error: 'Lab test not found' });

    return res.json({ success: true, labTest });
  } catch (error) {
    console.error('Error fetching lab test:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch lab test' });
  }
};

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
    if (status === 'completed') updateData.completedAt = new Date();

    const labTest = await LabTest.findOneAndUpdate(
      { _id: id, pathologyId: profile._id },
      updateData,
      { new: true, runValidators: true }
    );

    if (!labTest) return res.status(404).json({ success: false, error: 'Lab test not found' });

    return res.json({ success: true, message: 'Test status updated successfully', labTest });
  } catch (error) {
    console.error('Error updating test status:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

exports.uploadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { reportUrl, findings, remarks } = req.body || {};

    if (!reportUrl) return res.status(400).json({ success: false, error: 'Report URL is required' });

    const profile = await PathologyProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

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

    return res.json({ success: true, message: 'Report uploaded successfully', labTest });
  } catch (error) {
    console.error('Error uploading report:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

exports.getDashboardStats = async (req, res) => {
  try {
    const profile = await PathologyProfile.findOne({ userId: req.user.id })
      .select('labName averageRating totalTestsConducted homeCollectionAvailable');

    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

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
      { $group: { _id: null, totalTests: { $sum: 1 }, totalRevenue: { $sum: '$totalAmount' } } }
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

    return res.json({
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
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
};

// ===================== ✅ NEW: APPOINTMENTS (pathology) =====================

// GET /pathology/appointments
exports.getMyAppointments = async (req, res) => {
  try {
    const { status, startDate, endDate, page = 1, limit = 20 } = req.query;

    const profile = await PathologyProfile.findOne({ userId: req.user.id }).select('_id labName');
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const filter = {
      professionalType: 'pathology',
      pathologyId: profile._id
    };

    if (status) filter.status = status;

    if (startDate && endDate) {
      const s = startOfDay(new Date(startDate));
      const e = endOfDay(new Date(endDate));
      filter.appointmentDate = { $gte: s, $lte: e };
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender address')
      .sort({ appointmentDate: 1, startTime: 1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await Appointment.countDocuments(filter);

    return res.json({
      success: true,
      labName: profile.labName,
      appointments,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (error) {
    console.error('Error fetching pathology appointments:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch appointments' });
  }
};

// GET /pathology/appointments/:id
exports.getAppointmentByIdForPathology = async (req, res) => {
  try {
    const profile = await PathologyProfile.findOne({ userId: req.user.id }).select('_id');
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      professionalType: 'pathology',
      pathologyId: profile._id
    })
      .populate('patientId', 'name phone age gender bloodGroup address')
      .populate('referralId', 'requirement symptoms');

    if (!appointment) return res.status(404).json({ success: false, error: 'Appointment not found' });

    return res.json({ success: true, appointment });
  } catch (error) {
    console.error('Error fetching appointment:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch appointment' });
  }
};

// PATCH /pathology/appointments/:id/status
exports.updateAppointmentStatusForPathology = async (req, res) => {
  try {
    const { status, notes, cancellationReason } = req.body || {};
    if (!status) return res.status(400).json({ success: false, error: 'status is required' });
    if (!isValidAppointmentStatus(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status value' });
    }

    const profile = await PathologyProfile.findOne({ userId: req.user.id }).select('_id');
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      professionalType: 'pathology',
      pathologyId: profile._id
    });

    if (!appointment) return res.status(404).json({ success: false, error: 'Appointment not found' });

    // basic guards
    if (appointment.status === 'completed' && status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Completed appointment cannot be changed' });
    }
    if (appointment.status === 'cancelled' && status !== 'cancelled') {
      return res.status(400).json({ success: false, error: 'Cancelled appointment cannot be changed' });
    }

    appointment.status = status;

    if (notes) {
      appointment.notes = notes; // your schema uses string; if array, adjust
    }

    if (status === 'cancelled') {
      appointment.cancellationReason = cancellationReason || 'Cancelled by pathology';
      appointment.cancelledBy = 'professional';
      appointment.cancelledAt = new Date();
    }

    await appointment.save();

    return res.json({
      success: true,
      message: 'Appointment status updated',
      appointment
    });
  } catch (error) {
    console.error('Error updating appointment status:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

// ===================== ADMIN =====================

exports.updateLabByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...(req.body || {}) };

    const allowed = [
      'verificationStatus',
      'adminNotes',
      'verifiedAt',
      'verifiedBy',
      'commissionRate',
      'labName',
      'phone',
      'email',
      'website',
      'homeCollectionAvailable',
      'homeCollectionCharges',
      'services',
      'operatingHours',
      'accreditation',
      'licenses',
      'address'
    ];

    const $set = {};
    for (const k of allowed) {
      if (updates[k] !== undefined) $set[k] = updates[k];
    }

    if ($set.email) $set.email = normalizeEmail($set.email);
    if ($set.phone) $set.phone = normalizePhone($set.phone);
    if ($set.services) $set.services = sanitizeServices($set.services);

    if ($set.address) {
      const addr = $set.address;
      delete $set.address;
      if (addr.street !== undefined) $set['address.street'] = addr.street;
      if (addr.city !== undefined) $set['address.city'] = addr.city;
      if (addr.state !== undefined) $set['address.state'] = addr.state;
      if (addr.pincode !== undefined) $set['address.pincode'] = addr.pincode;

      if (addr.location?.coordinates) {
        $set['address.location.type'] = 'Point';
        $set['address.location.coordinates'] = sanitizeCoords(addr.location.coordinates);
      }
    }

    const lab = await PathologyProfile.findByIdAndUpdate(id, { $set }, { new: true, runValidators: true });
    if (!lab) return res.status(404).json({ success: false, error: 'Lab not found' });

    return res.json({ success: true, message: 'Lab updated successfully', lab });
  } catch (error) {
    console.error('Error updating lab by admin:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

exports.deleteLabByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const lab = await PathologyProfile.findById(id);
    if (!lab) return res.status(404).json({ success: false, error: 'Lab not found' });

    await PathologyProfile.deleteOne({ _id: id });
    await User.updateOne({ _id: lab.userId }, { $unset: { profileId: 1 } });

    return res.json({ success: true, message: 'Lab deleted successfully' });
  } catch (error) {
    console.error('Error deleting lab:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to delete lab' });
  }
};
