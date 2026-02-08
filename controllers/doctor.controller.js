// controllers/doctor.controller.js (updated to match DoctorProfile schema)
const DoctorProfile = require('../models/DoctorProfile');
const User = require('../models/User');
const Calendar = require('../models/Calendar');
const { initializeCalendarForMonth, updateDoctorInCalendar } = require('../jobs/calendarJob');
const Appointment = require('../models/Appointment');

// ========== PUBLIC FUNCTIONS ==========

// ✅ Create current doctor's profile (Doctor only)  POST /doctor
exports.createDoctor = async (req, res) => {
  try {
    // prevent duplicate profile (userId is unique in schema)
    const existing = await DoctorProfile.findOne({ userId: req.user.id });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Doctor profile already exists',
        doctor: existing
      });
    }

    // normalize incoming fields according to schema
    const body = req.body || {};

    const contactNumber = body.contactNumber || body.phone || '';
    const email = req.user?.email || body.email || '';

    const specialization = Array.isArray(body.specialization)
      ? body.specialization.filter(Boolean)
      : typeof body.specialization === 'string'
        ? body.specialization.split(',').map(s => s.trim()).filter(Boolean)
        : [];

    const consultationFee = Number(body.consultationFee);
    const homeVisitFee = body.homeVisitFee !== undefined ? Number(body.homeVisitFee) : 0;

    const experienceYears =
      body.experienceYears !== undefined ? Number(body.experienceYears)
      : body.experience !== undefined ? Number(body.experience)
      : 0;

    // clinicAddress: schema expects { address, city, state, pincode, location }
    const ca = body.clinicAddress || body.address || {};
    const clinicAddress = {
      address: ca.address || ca.street || '',
      city: ca.city || '',
      state: ca.state || '',
      pincode: ca.pincode || '',
      location: ca.location && Array.isArray(ca.location.coordinates)
        ? ca.location
        : { type: 'Point', coordinates: [0, 0] }
    };

    // validate required schema fields
    if (!body.name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    if (!specialization.length) {
      return res.status(400).json({ success: false, error: 'specialization is required' });
    }
    if (!body.licenseNumber) {
      return res.status(400).json({ success: false, error: 'licenseNumber is required' });
    }
    if (Number.isNaN(consultationFee)) {
      return res.status(400).json({ success: false, error: 'consultationFee is required' });
    }

    // qualifications schema: { degree, university, year, certificateUrl }
    const qualifications = Array.isArray(body.qualifications)
      ? body.qualifications.map(q => ({
          degree: q.degree || '',
          university: q.university || '',
          year: q.year !== undefined && q.year !== null && q.year !== '' ? Number(q.year) : undefined,
          certificateUrl: q.certificateUrl || ''
        }))
      : [];

    // availability already matches availabilitySlotSchema in your model
    const availability = Array.isArray(body.availability) ? body.availability : [];

    const newDoctor = await DoctorProfile.create({
      userId: req.user.id,
      name: body.name,
      profileImage: body.profileImage,

      gender: body.gender,
      dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,

      specialization,
      qualifications,

      experienceYears: Number.isNaN(experienceYears) ? 0 : experienceYears,

      licenseNumber: body.licenseNumber,
      licenseDocument: body.licenseDocument,

      clinicAddress,

      consultationFee,
      homeVisitFee: Number.isNaN(homeVisitFee) ? 0 : homeVisitFee,

      availability,

      languages: Array.isArray(body.languages) ? body.languages : (body.languages ? [body.languages] : ['English']),
      about: body.about || '',
      services: Array.isArray(body.services) ? body.services : [],

      // verificationStatus defaults to 'pending' by schema
      contactNumber,
      emergencyContact: body.emergencyContact,
      email,

      bankDetails: body.bankDetails ? {
        accountName: body.bankDetails.accountName,
        accountNumber: body.bankDetails.accountNumber,
        ifscCode: body.bankDetails.ifscCode,
        bankName: body.bankDetails.bankName,
        branch: body.bankDetails.branch
      } : undefined,

      commissionRate: body.commissionRate !== undefined ? Number(body.commissionRate) : undefined
    });

    // Update calendar with doctor's availability
    try {
      console.log(`🗓️ Adding new doctor ${newDoctor.name} to calendar...`);
      await addDoctorToCalendar(newDoctor);
      console.log(`✅ Calendar updated for Doctor ${newDoctor.name}`);
    } catch (calendarError) {
      console.error('❌ Failed to update calendar with new doctor:', calendarError);
    }

    return res.status(201).json({
      success: true,
      message: 'Doctor profile created successfully. Pending admin verification.',
      doctor: newDoctor
    });
  } catch (err) {
    console.error('Doctor creation error:', err);
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// Get all doctors (public)
exports.getAllDoctors = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      specialization,
      verificationStatus,
      search,
      minRating,
      maxFee,
      city
    } = req.query;

    const filter = {};

    if (specialization) filter.specialization = { $in: [specialization] };

    // Default: only approved doctors for public
    filter.verificationStatus = verificationStatus || 'approved';

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { specialization: { $regex: search, $options: 'i' } }
      ];
    }

    if (minRating) filter.averageRating = { $gte: parseFloat(minRating) };
    if (maxFee) filter.consultationFee = { $lte: parseFloat(maxFee) };
    if (city) filter['clinicAddress.city'] = { $regex: city, $options: 'i' };

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const doctors = await DoctorProfile.find(filter)
      // DoctorProfile has no password field; keep public-safe fields
      .select(
        'name profileImage gender specialization qualifications experienceYears clinicAddress consultationFee homeVisitFee languages about services verificationStatus averageRating totalReviews totalConsultations'
      )
      .populate('userId', 'email isVerified')
      .sort({ averageRating: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await DoctorProfile.countDocuments(filter);

    return res.json({
      success: true,
      doctors,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error fetching doctors:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch doctors'
    });
  }
};

// Get doctor by ID (public)
exports.getDoctorById = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findById(req.params.id)
      .select('-bankDetails -licenseDocument -adminNotes -commissionRate -pendingCommission -paidCommission')
      .populate('userId', 'email isVerified');

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor not found'
      });
    }

    const Appointment = require('../models/Appointment');
    const upcomingAppointments = await Appointment.find({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: new Date() },
      status: { $in: ['confirmed', 'accepted'] }
    })
      .select('appointmentDate startTime type')
      .sort({ appointmentDate: 1 })
      .limit(5);

    return res.json({
      success: true,
      doctor: {
        ...doctor.toObject(),
        upcomingAppointments
      }
    });
  } catch (err) {
    console.error('Error fetching doctor:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch doctor details'
    });
  }
};

// Get doctors by specialization (public)
exports.getDoctorsBySpecialization = async (req, res) => {
  try {
    const { specialization } = req.params;
    const { city, minRating, maxFee, page = 1, limit = 20 } = req.query;

    const filter = {
      verificationStatus: 'approved'
    };

    // ✅ Only filter specialization if it's not "all"
    if (specialization !== 'all') {
      filter.specialization = { $in: [specialization] };
    }

    if (city) filter['clinicAddress.city'] = { $regex: city, $options: 'i' };
    if (minRating) filter.averageRating = { $gte: parseFloat(minRating) };
    if (maxFee) filter.consultationFee = { $lte: parseFloat(maxFee) };

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const doctors = await DoctorProfile.find(filter)
      .select('name profileImage specialization averageRating consultationFee homeVisitFee clinicAddress availability totalConsultations')
      .sort({ averageRating: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await DoctorProfile.countDocuments(filter);

    return res.json({
      success: true,
      specialization,
      count: doctors.length,
      doctors,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error fetching doctors by specialization:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch doctors'
    });
  }
};


// Get doctor's availability (public)
exports.getDoctorAvailability = async (req, res) => {
  try {
    const { id } = req.params;     // doctor profile id
    const { date } = req.query;    // YYYY-MM-DD

    // ---- Helpers ----
    const dateKeyLocal = (d) => {
      const x = new Date(d);
      const y = x.getFullYear();
      const m = String(x.getMonth() + 1).padStart(2, '0');
      const dd = String(x.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };

    const timeToMinutes = (t) => {
      const [hh, mm] = String(t || "00:00").split(":").map(Number);
      return hh * 60 + mm;
    };

    const minutesToHHMM = (mins) => {
      const hh = String(Math.floor(mins / 60)).padStart(2, '0');
      const mm = String(mins % 60).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

    const clampInterval = (s, e, min, max) => ({
      start: Math.max(min, s),
      end: Math.min(max, e)
    });

    const isValidInterval = (iv) => iv && Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start;

    // Merge overlapping/adjacent intervals
    const mergeIntervals = (intervals) => {
      const arr = (intervals || []).filter(isValidInterval).sort((a, b) => a.start - b.start);
      if (!arr.length) return [];
      const out = [arr[0]];
      for (let i = 1; i < arr.length; i++) {
        const prev = out[out.length - 1];
        const cur = arr[i];
        if (cur.start <= prev.end) {
          prev.end = Math.max(prev.end, cur.end);
        } else {
          out.push({ ...cur });
        }
      }
      return out;
    };

    // Subtract busy intervals from a [start,end) base interval
    const subtractIntervals = (baseStart, baseEnd, busyMerged) => {
      let cursor = baseStart;
      const free = [];
      for (const b of busyMerged) {
        if (b.end <= cursor) continue;
        if (b.start >= baseEnd) break;

        const bs = Math.max(b.start, baseStart);
        const be = Math.min(b.end, baseEnd);

        if (bs > cursor) free.push({ start: cursor, end: bs });
        cursor = Math.max(cursor, be);
      }
      if (cursor < baseEnd) free.push({ start: cursor, end: baseEnd });
      return free;
    };

    const sumMinutes = (intervals) => (intervals || []).reduce((acc, iv) => acc + (iv.end - iv.start), 0);

    // ---- Validate target date ----
    const targetDate = date ? new Date(date) : new Date();
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date format' });
    }

    const targetDayStart = new Date(targetDate);
    targetDayStart.setHours(0, 0, 0, 0);

    const targetDayEnd = new Date(targetDate);
    targetDayEnd.setHours(23, 59, 59, 999);

    const year = targetDayStart.getFullYear();
    const month = targetDayStart.getMonth() + 1;
    const targetKey = dateKeyLocal(targetDayStart);

    // ---- Fetch doctor profile ----
    const doctor = await DoctorProfile.findById(id)
      .select('name consultationFee homeVisitFee verificationStatus userId')
      .populate('userId', 'isVerified isActive');

    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor not found' });
    }

    if (doctor.verificationStatus !== 'approved') {
      return res.status(400).json({ success: false, error: 'Doctor profile is not approved' });
    }

    // Optional extra gating
    if (!doctor.userId?.isVerified || doctor.userId?.isActive === false) {
      return res.status(400).json({
        success: false,
        error: 'Doctor is not available for appointments'
      });
    }

    // ---- Calendar lookup (source of truth) ----
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar && typeof initializeCalendarForMonth === "function") {
      calendar = await initializeCalendarForMonth(year, month);
    }

    const emptyResponse = (dayName) => res.json({
      success: true,
      date: targetKey,
      dayName,
      isAvailable: false,
      slots: [],
      doctorName: doctor.name,
      consultationFee: doctor.consultationFee,
      homeVisitFee: doctor.homeVisitFee
    });

    if (!calendar || !Array.isArray(calendar.days)) {
      return emptyResponse(targetDayStart.toLocaleDateString('en-US', { weekday: 'long' }));
    }

    const day = calendar.days.find(d => dateKeyLocal(d.date) === targetKey);
    if (!day) {
      return emptyResponse(targetDayStart.toLocaleDateString('en-US', { weekday: 'long' }));
    }

    const professionalSchedule = (day.professionals || []).find(p =>
      String(p.professionalId) === String(id) && p.professionalType === 'doctor'
    );

    if (!professionalSchedule || !professionalSchedule.isAvailable) {
      return res.json({
        success: true,
        date: targetKey,
        dayName: day.dayName,
        isAvailable: false,
        slots: [],
        doctorName: doctor.name,
        consultationFee: doctor.consultationFee,
        homeVisitFee: doctor.homeVisitFee
      });
    }

    const workingHours = professionalSchedule.workingHours || [];
    const breaks = professionalSchedule.breaks || [];
    const bookedSlots = professionalSchedule.bookedSlots || [];

    if (!workingHours.length) {
      return res.json({
        success: true,
        date: targetKey,
        dayName: day.dayName,
        isAvailable: false,
        slots: [],
        doctorName: doctor.name,
        consultationFee: doctor.consultationFee,
        homeVisitFee: doctor.homeVisitFee
      });
    }

    // ---- Appointment truth (avoid stale calendar) ----
    const existingAppointments = await Appointment.find({
      doctorId: id,
      appointmentDate: { $gte: targetDayStart, $lte: targetDayEnd },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    }).select('startTime endTime status');

    // ---- Build busy intervals (global for the day) ----
    const busyRaw = [];

    // Breaks
    for (const br of breaks) {
      const s = timeToMinutes(br.startTime);
      const e = timeToMinutes(br.endTime);
      if (e > s) busyRaw.push({ start: s, end: e, source: 'break' });
    }

    // Calendar bookedSlots (ignore cancelled)
    for (const b of bookedSlots) {
      if ((b.status || 'booked') === 'cancelled') continue;
      const s = timeToMinutes(b.startTime);
      const e = b.endTime ? timeToMinutes(b.endTime) : (s + 30); // fallback
      if (e > s) busyRaw.push({ start: s, end: e, source: 'calendar' });
    }

    // Real appointments
    for (const a of existingAppointments) {
      const s = timeToMinutes(a.startTime);
      const e = timeToMinutes(a.endTime);
      if (e > s) busyRaw.push({ start: s, end: e, source: 'appointment' });
    }

    // We merge by time (drop source at merge-level, but keep if you want detail)
    const busyMerged = mergeIntervals(busyRaw.map(({ start, end }) => ({ start, end })));

    // ---- Build working hour blocks with free/busy ----
    const slotBlocks = workingHours.map((wh) => {
      const whStart = timeToMinutes(wh.startTime);
      const whEnd = timeToMinutes(wh.endTime);

      if (whEnd <= whStart) return null;

      // Busy intervals limited to this working block
      const busyInBlock = busyMerged
        .map((b) => clampInterval(b.start, b.end, whStart, whEnd))
        .filter(isValidInterval);

      const busyInBlockMerged = mergeIntervals(busyInBlock);

      // Free intervals within the block
      const freeInBlock = subtractIntervals(whStart, whEnd, busyInBlockMerged);
      const freeInBlockMerged = mergeIntervals(freeInBlock);

      const busyMinutes = sumMinutes(busyInBlockMerged);
      const freeMinutes = sumMinutes(freeInBlockMerged);

      const hasFree = freeMinutes > 0;

      // Keep response structure similar + add free/busy
      const slotType = wh.type || "clinic"; // if you store type per WH, keep it; else default clinic
      const fee = slotType === "home" ? doctor.homeVisitFee : doctor.consultationFee;

      return {
        startTime: wh.startTime,
        endTime: wh.endTime,
        type: slotType,
        maxPatients: Number.isFinite(wh.maxPatients) ? wh.maxPatients : 1,

        // IMPORTANT: block is "booked" only if fully covered (no free time)
        isBooked: !hasFree,
        isAvailable: hasFree,

        fee,

        // NEW: for UI + debugging
        busyMinutes,
        freeMinutes,
        busyIntervals: busyInBlockMerged.map(iv => ({
          startTime: minutesToHHMM(iv.start),
          endTime: minutesToHHMM(iv.end)
        })),
        freeIntervals: freeInBlockMerged.map(iv => ({
          startTime: minutesToHHMM(iv.start),
          endTime: minutesToHHMM(iv.end)
        }))
      };
    }).filter(Boolean);

    return res.json({
      success: true,
      date: targetKey,
      dayName: day.dayName,

      // day is available if ANY block has any free time
      isAvailable: slotBlocks.some(s => s.isAvailable),

      slots: slotBlocks,
      doctorName: doctor.name,
      consultationFee: doctor.consultationFee,
      homeVisitFee: doctor.homeVisitFee
    });
  } catch (err) {
    console.error('Error fetching doctor availability:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch availability'
    });
  }
};



// Get current doctor's profile  GET /doctor/me/profile
exports.getProfile = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .populate('userId', 'email isVerified lastLogin');

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor profile not found'
      });
    }

    return res.json({ success: true, doctor });
  } catch (err) {
    console.error('Error fetching doctor profile:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch profile'
    });
  }
};

// Update current doctor's profile  PUT /doctor/me/profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };

    // Map "phone" -> contactNumber (schema field)
    if (updates.phone && !updates.contactNumber) {
      updates.contactNumber = updates.phone;
      delete updates.phone;
    }

    // Support address shape from frontend modal: { clinicAddress: { street, city... } }
    if (updates.clinicAddress?.street && !updates.clinicAddress.address) {
      updates.clinicAddress.address = updates.clinicAddress.street;
      delete updates.clinicAddress.street;
    }

    // Remove fields that shouldn't be updated directly by doctor
    delete updates.userId;
    delete updates.verificationStatus;
    delete updates.adminNotes;
    delete updates.verifiedAt;
    delete updates.verifiedBy;
    delete updates.totalEarnings;
    delete updates.totalConsultations;
    delete updates.averageRating;
    delete updates.totalReviews;
    delete updates.pendingCommission;
    delete updates.paidCommission;
    delete updates.commissionRate;

    // Get current doctor first to check if availability is changing
    const currentDoctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!currentDoctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor profile not found'
      });
    }

    const doctor = await DoctorProfile.findOneAndUpdate(
      { userId: req.user.id },
      updates,
      { new: true, runValidators: true }
    ).populate('userId', 'email');

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor profile not found'
      });
    }

    // If email changed in profile, reflect in User too
    if (updates.email && doctor.userId) {
      await User.findByIdAndUpdate(doctor.userId, { email: updates.email });
    }

    // Check if availability was updated and trigger immediate calendar sync
    if (updates.availability && 
        JSON.stringify(currentDoctor.availability) !== JSON.stringify(updates.availability)) {
      try {
        console.log('🔄 Availability changed, triggering immediate calendar sync...');
        // Trigger immediate calendar update in background
        setTimeout(async () => {
          try {
            await updateDoctorInCalendar(doctor._id, doctor);
            console.log('✅ Calendar synced immediately after availability update');
          } catch (syncError) {
            console.error('❌ Immediate calendar sync failed:', syncError);
          }
        }, 1000); // 1 second delay
      } catch (error) {
        console.error('Error triggering immediate calendar sync:', error);
      }
    }

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      doctor
    });
  } catch (err) {
    console.error('Error updating doctor profile:', err.message);
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// Update current doctor's availability
exports.updateAvailability = async (req, res) => {
  try {
    const { availability } = req.body;

    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    // Store old availability for comparison
    const oldAvailability = doctor.availability;
    
    doctor.availability = availability;
    await doctor.save();

    // Update calendar with new availability - ONLY if availability actually changed
    if (JSON.stringify(oldAvailability) !== JSON.stringify(availability)) {
      try {
        console.log('🔄 Availability changed, updating calendar immediately...');
        
        // Trigger immediate update
        const result = await updateDoctorInCalendar(doctor._id, doctor);
        
        if (result.success) {
          console.log(`✅ Calendar updated immediately for ${doctor.name}`);
        } else {
          console.error('❌ Immediate calendar update failed:', result.error);
          // Don't fail the request, just log error
        }
      } catch (calendarError) {
        console.error('❌ Error updating doctor in calendar:', calendarError);
        // Don't fail the request, just log the error
      }
    }

    res.json({
      success: true,
      message: 'Availability updated successfully',
      availability: doctor.availability
    });
  } catch (err) {
    console.error('Error updating availability:', err.message);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
};

// Add manual calendar sync endpoint for doctors
exports.syncCalendar = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor profile not found'
      });
    }

    console.log(`🔄 Manual calendar sync requested by Doctor: ${doctor.name}`);
    
    const result = await updateDoctorInCalendar(doctor._id, doctor);
    
    if (result.success) {
      return res.json({
        success: true,
        message: 'Calendar synced successfully',
        updates: result.totalUpdates,
        doctorName: doctor.name
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to sync calendar'
      });
    }
  } catch (error) {
    console.error('Manual calendar sync error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to sync calendar'
    });
  }
};

// Get current doctor's appointments
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

    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    const filter = { 
      doctorId: doctor._id,
      professionalType: 'doctor'
    };

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.appointmentDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const Appointment = require('../models/Appointment');
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('referralId', 'requirement')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Appointment.countDocuments(filter);

    res.json({
      success: true,
      appointments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Error fetching appointments:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch appointments' 
    });
  }
};

// Get current doctor's earnings summary
exports.getEarnings = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .select('totalEarnings pendingCommission paidCommission totalConsultations');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const Commission = require('../models/Commission');
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: doctor._id,
          professionalType: 'doctor',
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
        totalEarnings: doctor.totalEarnings || 0,
        pendingCommission: doctor.pendingCommission || 0,
        paidCommission: doctor.paidCommission || 0,
        monthlyEarnings: monthlyEarnings[0]?.totalEarnings || 0,
        monthlyCommission: monthlyEarnings[0]?.totalCommission || 0
      },
      stats: {
        totalConsultations: doctor.totalConsultations || 0
      }
    });
  } catch (err) {
    console.error('Error fetching earnings:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch earnings data' 
    });
  }
};

// Get current doctor's detailed earnings report
exports.getDoctorEarnings = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id });
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor profile not found' 
      });
    }

    const { startDate, endDate, groupBy = 'month' } = req.query;

    const matchStage = {
      professionalId: doctor._id,
      professionalType: 'doctor'
    };

    if (startDate && endDate) {
      matchStage.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const Commission = require('../models/Commission');
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
          professionalId: doctor._id,
          professionalType: 'doctor',
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
        totalEarnings: doctor.totalEarnings || 0,
        pendingCommission: doctor.pendingCommission || 0,
        paidCommission: doctor.paidCommission || 0
      }
    });
  } catch (err) {
    console.error('Error fetching earnings report:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch earnings report' 
    });
  }
};

// Get current doctor's dashboard
exports.getDoctorDashboard = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .select('name specialization averageRating totalConsultations totalEarnings');

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: 'Doctor profile not found'
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get today's appointments
    const Appointment = require('../models/Appointment');
    const todaysAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted'] }
    });

    // Get pending appointments
    const pendingAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      status: 'pending'
    });

    // Get this month's earnings
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const Commission = require('../models/Commission');
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: doctor._id,
          professionalType: 'doctor',
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
      doctorId: doctor._id,
      professionalType: 'doctor'
    })
    .populate('patientId', 'name')
    .sort({ appointmentDate: -1 })
    .limit(5);

    res.json({
      success: true,
      stats: {
        totalConsultations: doctor.totalConsultations || 0,
        totalEarnings: doctor.totalEarnings || 0,
        averageRating: doctor.averageRating || 0,
        todaysAppointments,
        pendingAppointments,
        monthlyEarnings: monthlyEarnings[0]?.total || 0
      },
      recentAppointments,
      profile: {
        name: doctor.name,
        specialization: doctor.specialization
      }
    });
  } catch (err) {
    console.error('Error fetching doctor dashboard:', err.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data'
    });
  }
};

// ========== ADMIN-ONLY FUNCTIONS ==========

// Update any doctor by ID (Admin only)
exports.updateDoctor = async (req, res) => {
  try {
    const doctorId = req.params.id;
    const updates = req.body;

    // Remove fields that shouldn't be updated directly
    delete updates.totalEarnings;
    delete updates.totalConsultations;
    delete updates.pendingCommission;
    delete updates.paidCommission;

    const doctor = await DoctorProfile.findByIdAndUpdate(
      doctorId,
      updates,
      { new: true, runValidators: true }
    ).populate('userId', 'email');

    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor not found' 
      });
    }

    // Update associated user if email changed
    if (updates.email && doctor.userId) {
      await User.findByIdAndUpdate(doctor.userId, {
        email: updates.email
      });
    }

    // Update calendar if availability changed
    if (updates.availability) {
      try {
        await updateDoctorInCalendar(doctorId, doctor);
      } catch (calendarError) {
        console.error('Error updating doctor in calendar:', calendarError);
      }
    }

    res.json({
      success: true,
      message: 'Doctor updated successfully',
      doctor
    });
  } catch (err) {
    console.error('Error updating doctor:', err.message);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
};

// Delete doctor by ID (Admin only)
exports.deleteDoctor = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findById(req.params.id);
    if (!doctor) {
      return res.status(404).json({ 
        success: false,
        error: 'Doctor not found' 
      });
    }

    // Check if doctor has upcoming appointments
    const Appointment = require('../models/Appointment');
    const upcomingAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: new Date() },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    });

    if (upcomingAppointments > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete doctor with upcoming appointments. Cancel appointments first.'
      });
    }

    // Remove doctor from calendar before deleting
    try {
      await removeDoctorFromCalendar(doctor._id);
    } catch (calendarError) {
      console.error('Error removing doctor from calendar:', calendarError);
    }

    // Delete associated user
    if (doctor.userId) {
      await User.findByIdAndDelete(doctor.userId);
    }

    // Delete the doctor profile
    await DoctorProfile.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Doctor deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting doctor:', err.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete doctor' 
    });
  }
};

// Bulk create doctors (Admin only)
exports.bulkCreateDoctors = async (req, res) => {
  const doctorsData = req.body;
  console.log('Bulk import data:', doctorsData);

  if (!doctorsData || !Array.isArray(doctorsData)) {
    return res.status(400).json({ 
      success: false,
      error: 'Invalid data format. Expected an array.' 
    });
  }

  const successfulImports = [];
  const failedImports = [];

  for (const doctorData of doctorsData) {
    try {
      // Check if user already exists
      const userExists = await User.findOne({ email: doctorData.email });
      if (userExists) {
        throw new Error('User with this email already exists.');
      }

      // Create User
      const newUser = await User.create({
        name: doctorData.name,
        email: doctorData.email,
        password: doctorData.password || 'temporary123',
        role: 'doctor',
        phone: doctorData.phone
      });

      // Create DoctorProfile
      const newDoctor = await DoctorProfile.create({
        userId: newUser._id,
        name: doctorData.name,
        email: doctorData.email,
        contactNumber: doctorData.phone,
        specialization: doctorData.specialization || [],
        qualifications: doctorData.qualifications || [],
        experienceYears: doctorData.experienceYears || 0,
        licenseNumber: doctorData.licenseNumber,
        clinicAddress: {
          address: doctorData.address || '',
          city: doctorData.city || '',
          state: doctorData.state || '',
          pincode: doctorData.pincode || '',
          location: doctorData.location || {
            type: 'Point',
            coordinates: [0, 0]
          }
        },
        consultationFee: doctorData.consultationFee || 0,
        homeVisitFee: doctorData.homeVisitFee || 0,
        availability: doctorData.availability || [],
        about: doctorData.about || '',
        services: doctorData.services || [],
        gender: doctorData.gender,
        dateOfBirth: doctorData.dateOfBirth ? new Date(doctorData.dateOfBirth) : null,
        bankDetails: doctorData.bankDetails,
        commissionRate: doctorData.commissionRate || 20
      });

      // Add to calendar
      try {
        await addDoctorToCalendar(newDoctor);
      } catch (calendarError) {
        console.error('Error adding doctor to calendar during bulk import:', calendarError);
      }

      successfulImports.push({
        id: newDoctor._id,
        name: newDoctor.name,
        email: newDoctor.email
      });
    } catch (err) {
      failedImports.push({ 
        email: doctorData.email, 
        reason: err.message 
      });
    }
  }

  res.status(201).json({
    success: true,
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    successfulImports,
    failedImports
  });
};

// ========== HELPER FUNCTIONS ==========

// Helper function to add doctor to calendar
async function addDoctorToCalendar(doctor) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Generate dates for next 30 days
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

  let needsUpdate = false;

  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    
    // Check doctor's availability for this day
    const dayAvailability = doctor.availability?.find(a => a.day === dayName);
    if (!dayAvailability) continue;

    const existingDayIndex = calendar.days.findIndex(
      d => d.date.toISOString().split('T')[0] === dateStr
    );

    if (existingDayIndex !== -1) {
      const existingDay = calendar.days[existingDayIndex];
      const isDoctorAlreadyAdded = existingDay.professionals.some(
        p => p.professionalId.toString() === doctor._id.toString() && 
             p.professionalType === 'doctor'
      );

      if (!isDoctorAlreadyAdded) {
        needsUpdate = true;
        
        const bookedSlots = dayAvailability.slots.map(slot => ({
          startTime: slot.startTime,
          endTime: slot.endTime,
          isBooked: false,
          type: slot.type || 'clinic'
        }));

        existingDay.professionals.push({
          professionalId: doctor._id,
          professionalType: 'doctor',
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        });
      }
    } else {
      needsUpdate = true;
      
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
          professionalId: doctor._id,
          professionalType: 'doctor',
          bookedSlots: bookedSlots,
          breaks: [],
          isAvailable: true
        }]
      });
    }
  }

  if (needsUpdate) {
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

// Helper function to remove doctor from calendar
async function removeDoctorFromCalendar(doctorId) {
  const calendars = await Calendar.find({
    'days.professionals.professionalId': doctorId
  });

  for (const calendar of calendars) {
    let updated = false;
    
    for (const day of calendar.days) {
      const initialLength = day.professionals.length;
      day.professionals = day.professionals.filter(
        p => !(p.professionalId.toString() === doctorId.toString() && 
               p.professionalType === 'doctor')
      );
      
      if (day.professionals.length !== initialLength) {
        updated = true;
      }
    }
    
    calendar.days = calendar.days.filter(day => day.professionals.length > 0);
    
    if (updated) {
      await calendar.save();
    }
  }
}