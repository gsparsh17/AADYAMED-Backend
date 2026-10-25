// controllers/doctor.controller.js (updated to match DoctorProfile schema)
const DoctorProfile = require('../models/DoctorProfile');
const User = require('../models/User');
const Calendar = require('../models/Calendar');
const { initializeCalendarForMonth, updateDoctorInCalendar } = require('../jobs/calendarJob');
const Appointment = require('../models/Appointment');
const Feedback = require('../models/Feedback');
const {
  VALID_TYPES,
  getConsultationTypes,
  getDoctorTypeEnabled,
  getDoctorDailySlots,
  getNextAvailableSlot,
} = require('../services/doctorAvailability.service');

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

    const user = await User.findById(req.user.id);

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
    const videoCallFee = body.videoCallFee !== undefined ? Number(body.videoCallFee) : 0;

    const experienceYears =
      body.experienceYears !== undefined ? Number(body.experienceYears)
      : body.experience !== undefined ? Number(body.experience)
      : 0;

    // clinicAddress: schema expects { address, city, state, pincode, location }
    const ca = body.clinicAddress || body.address || {};
    const clinicAddress = {
      address: ca.address || ca.street || '',
      locality: ca.locality || ca.area || '',
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

      clinicName: body.clinicName || '',
      clinicAddress,

      consultationFee,
      homeVisitFee: Number.isNaN(homeVisitFee) ? 0 : homeVisitFee,
      videoCallFee: Number.isNaN(videoCallFee) ? 0 : videoCallFee,
      clinicConsultationEnabled: body.clinicConsultationEnabled !== false,
      homeVisitEnabled: body.homeVisitEnabled !== undefined ? Boolean(body.homeVisitEnabled) : (Number(homeVisitFee) > 0),
      teleconsultationEnabled: body.teleconsultationEnabled !== undefined ? Boolean(body.teleconsultationEnabled) : (Number(videoCallFee) > 0),
      slotDurationMinutes: body.slotDurationMinutes !== undefined ? Number(body.slotDurationMinutes) : 30,
      bookingWindowDays: body.bookingWindowDays !== undefined ? Number(body.bookingWindowDays) : 60,
      minimumNoticeMinutes: body.minimumNoticeMinutes !== undefined ? Number(body.minimumNoticeMinutes) : 60,

      availability,

      languages: Array.isArray(body.languages) ? body.languages : (body.languages ? [body.languages] : ['English']),
      about: body.about || '',
      services: Array.isArray(body.services) ? body.services : [],
      registrationCouncil: body.registrationCouncil || '',
      registrationYear: body.registrationYear ? Number(body.registrationYear) : undefined,
      awards: Array.isArray(body.awards) ? body.awards : [],
      memberships: Array.isArray(body.memberships) ? body.memberships : [],
      acceptedInsurance: Array.isArray(body.acceptedInsurance) ? body.acceptedInsurance : [],

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

    user.profileId=newDoctor._id;
    user.save();

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
      search,
      q,
      minRating,
      maxFee,
      minFee,
      city,
      locality,
      gender,
      language,
      type = 'clinic',
      sort = 'rating',
      availabilityDate,
      lat,
      lng,
      radiusKm = 25,
      includeNextAvailable = 'true',
    } = req.query;

    const consultationType = VALID_TYPES.includes(type) ? type : 'clinic';
    const filter = { verificationStatus: 'approved' };
    const escaped = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (specialization && specialization !== 'all') {
      filter.specialization = { $regex: `^${escaped(specialization)}$`, $options: 'i' };
    }

    const searchTerm = String(q || search || '').trim();
    if (searchTerm) {
      const regex = { $regex: escaped(searchTerm), $options: 'i' };
      filter.$or = [
        { name: regex },
        { specialization: regex },
        { services: regex },
        { clinicName: regex },
        { 'clinicAddress.city': regex },
        { 'clinicAddress.locality': regex },
      ];
    }

    if (city) filter['clinicAddress.city'] = { $regex: `^${escaped(city)}$`, $options: 'i' };
    if (locality) filter['clinicAddress.locality'] = { $regex: escaped(locality), $options: 'i' };
    if (gender) filter.gender = gender;
    if (language) filter.languages = { $regex: `^${escaped(language)}$`, $options: 'i' };
    if (minRating) filter.averageRating = { $gte: Number(minRating) || 0 };

    const feeField = consultationType === 'video'
      ? 'videoCallFee'
      : consultationType === 'home'
        ? 'homeVisitFee'
        : 'consultationFee';
    if (minFee || maxFee) {
      filter[feeField] = {};
      if (minFee) filter[feeField].$gte = Number(minFee) || 0;
      if (maxFee) filter[feeField].$lte = Number(maxFee) || 0;
    }

    if (consultationType === 'video') {
      filter.$and = [...(filter.$and || []), {
        $or: [
          { teleconsultationEnabled: true },
          { teleconsultationEnabled: { $exists: false }, videoCallFee: { $gt: 0 } },
        ],
      }];
    } else if (consultationType === 'home') {
      filter.$and = [...(filter.$and || []), {
        $or: [
          { homeVisitEnabled: true },
          { homeVisitEnabled: { $exists: false }, homeVisitFee: { $gt: 0 } },
        ],
      }];
    } else {
      filter.clinicConsultationEnabled = { $ne: false };
    }

    const latitude = Number(lat);
    const longitude = Number(lng);
    const radius = Math.max(1, Math.min(200, Number(radiusKm) || 25));
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      filter['clinicAddress.location'] = {
        $geoWithin: {
          $centerSphere: [[longitude, latitude], radius / 6378.1],
        },
      };
    }

    const sortMap = {
      rating: { averageRating: -1, totalReviews: -1, experienceYears: -1 },
      experience: { experienceYears: -1, averageRating: -1 },
      fee_low: { [feeField]: 1, averageRating: -1 },
      fee_high: { [feeField]: -1, averageRating: -1 },
      newest: { createdAt: -1 },
    };
    const sortSpec = sortMap[sort] || sortMap.rating;

    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const fields = [
      'name', 'profileImage', 'gender', 'specialization', 'qualifications', 'experienceYears',
      'clinicName', 'clinicAddress', 'consultationFee', 'homeVisitFee', 'videoCallFee',
      'clinicConsultationEnabled', 'homeVisitEnabled', 'teleconsultationEnabled',
      'slotDurationMinutes', 'bookingWindowDays', 'minimumNoticeMinutes', 'availability',
      'languages', 'about', 'services', 'averageRating', 'totalReviews', 'totalConsultations',
      'registrationCouncil', 'registrationYear', 'awards', 'memberships', 'acceptedInsurance',
    ].join(' ');

    let doctors;
    let total;

    if (availabilityDate) {
      const candidates = await DoctorProfile.find(filter).select(fields).sort(sortSpec).limit(300).lean();
      const availabilityResults = await Promise.all(candidates.map(async (doctor) => {
        try {
          const daily = await getDoctorDailySlots(doctor, availabilityDate, { type: consultationType });
          return daily.slots.length ? { doctor, daily } : null;
        } catch {
          return null;
        }
      }));
      const available = availabilityResults.filter(Boolean);
      total = available.length;
      doctors = available.slice((safePage - 1) * safeLimit, safePage * safeLimit).map((item) => ({
        ...item.doctor,
        availableSlots: item.daily.slots.slice(0, 5),
      }));
    } else {
      total = await DoctorProfile.countDocuments(filter);
      doctors = await DoctorProfile.find(filter)
        .select(fields)
        .sort(sortSpec)
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean();
    }

    const enriched = await Promise.all(doctors.map(async (doctor) => {
      const result = {
        ...doctor,
        consultationTypes: getConsultationTypes(doctor),
      };

      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        const coordinates = doctor.clinicAddress?.location?.coordinates;
        if (Array.isArray(coordinates) && coordinates.length === 2) {
          const toRad = (value) => value * Math.PI / 180;
          const dLat = toRad(Number(coordinates[1]) - latitude);
          const dLon = toRad(Number(coordinates[0]) - longitude);
          const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(latitude)) * Math.cos(toRad(Number(coordinates[1]))) * Math.sin(dLon / 2) ** 2;
          result.distanceKm = Number((6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1));
        }
      }

      if (includeNextAvailable !== 'false' && !availabilityDate) {
        try {
          result.nextAvailable = await getNextAvailableSlot(doctor, { type: consultationType, daysToScan: 14 });
        } catch {
          result.nextAvailable = null;
        }
      }
      return result;
    }));

    return res.json({
      success: true,
      doctors: enriched,
      filters: { consultationType, specialization: specialization || null, city: city || null },
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (err) {
    console.error('Error fetching doctors:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch doctors' });
  }
};

exports.getDoctorById = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({
      _id: req.params.id,
      verificationStatus: 'approved',
    })
      .select('-bankDetails -licenseDocument -adminNotes -commissionRate -pendingCommission -paidCommission')
      .lean();

    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor not found or not available publicly' });
    }

    const [reviews, reviewStats] = await Promise.all([
      Feedback.find({
        professionalId: doctor._id,
        professionalType: 'doctor',
        status: 'approved',
      })
        .select('overallRating comments wouldRecommend professionalResponse createdAt patientId isAnonymous')
        .populate('patientId', 'name')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      Feedback.aggregate([
        { $match: { professionalId: doctor._id, professionalType: 'doctor', status: 'approved' } },
        { $group: { _id: '$overallRating', count: { $sum: 1 } } },
      ]),
    ]);

    const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    reviewStats.forEach((item) => {
      ratingDistribution[item._id] = item.count;
    });

    let nextAvailable = null;
    try {
      nextAvailable = await getNextAvailableSlot(doctor, { type: req.query.type || 'clinic', daysToScan: 14 });
    } catch {
      nextAvailable = null;
    }

    const safeReviews = reviews.map((review) => ({
      ...review,
      patientId: review.isAnonymous ? null : review.patientId,
    }));

    return res.json({
      success: true,
      doctor: {
        ...doctor,
        consultationTypes: getConsultationTypes(doctor),
        nextAvailable,
      },
      reviews: safeReviews,
      ratingDistribution,
    });
  } catch (err) {
    console.error('Error fetching doctor:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch doctor details' });
  }
};

exports.getDoctorsBySpecialization = async (req, res) => {
  req.query = { ...req.query, specialization: req.params.specialization };
  return exports.getAllDoctors(req, res);
};

exports.getWeeklyAvailability = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ _id: req.params.id, verificationStatus: 'approved' })
      .select('availability name consultationFee homeVisitFee videoCallFee slotDurationMinutes bookingWindowDays minimumNoticeMinutes clinicConsultationEnabled homeVisitEnabled teleconsultationEnabled');

    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor not found' });
    }

    return res.json({
      success: true,
      availability: doctor.availability || [],
      doctorName: doctor.name,
      consultationFee: doctor.consultationFee,
      homeVisitFee: doctor.homeVisitFee,
      videoCallFee: doctor.videoCallFee,
      clinicConsultationEnabled: getDoctorTypeEnabled(doctor, 'clinic'),
      homeVisitEnabled: getDoctorTypeEnabled(doctor, 'home'),
      teleconsultationEnabled: getDoctorTypeEnabled(doctor, 'video'),
      consultationTypes: getConsultationTypes(doctor),
      slotDurationMinutes: doctor.slotDurationMinutes || 30,
      bookingWindowDays: doctor.bookingWindowDays || 60,
      minimumNoticeMinutes: doctor.minimumNoticeMinutes || 60,
    });
  } catch (err) {
    console.error('Error fetching weekly availability:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch weekly availability' });
  }
};

exports.getMyAvailability = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ userId: req.user.id })
      .select('availability name consultationFee homeVisitFee videoCallFee slotDurationMinutes bookingWindowDays minimumNoticeMinutes clinicConsultationEnabled homeVisitEnabled teleconsultationEnabled');

    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor profile not found' });
    }

    return res.json({
      success: true,
      availability: doctor.availability || [],
      doctorName: doctor.name,
      consultationFee: doctor.consultationFee,
      homeVisitFee: doctor.homeVisitFee,
      videoCallFee: doctor.videoCallFee,
      consultationTypes: getConsultationTypes(doctor),
      slotDurationMinutes: doctor.slotDurationMinutes || 30,
      bookingWindowDays: doctor.bookingWindowDays || 60,
      minimumNoticeMinutes: doctor.minimumNoticeMinutes || 60,
    });
  } catch (err) {
    console.error('Error fetching own availability:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch availability' });
  }
};

exports.getDoctorAvailability = async (req, res) => {
  try {
    const doctor = await DoctorProfile.findOne({ _id: req.params.id, verificationStatus: 'approved' })
      .select('name availability consultationFee homeVisitFee videoCallFee clinicConsultationEnabled homeVisitEnabled teleconsultationEnabled slotDurationMinutes bookingWindowDays minimumNoticeMinutes');

    if (!doctor) {
      return res.status(404).json({ success: false, error: 'Doctor not found' });
    }

    const daily = await getDoctorDailySlots(doctor, req.query.date || new Date(), {
      type: req.query.type || 'clinic',
      duration: req.query.duration,
      includeUnavailable: req.query.includeUnavailable === 'true',
    });

    return res.json({
      success: true,
      ...daily,
      availableSlots: daily.slots.filter((slot) => slot.isAvailable !== false),
      doctorName: doctor.name,
      consultationFee: doctor.consultationFee,
      homeVisitFee: doctor.homeVisitFee,
      videoCallFee: doctor.videoCallFee,
      consultationTypes: getConsultationTypes(doctor),
    });
  } catch (err) {
    console.error('Error fetching doctor availability:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.statusCode ? err.message : 'Failed to fetch availability',
    });
  }
};

exports.getDoctorDirectoryMeta = async (req, res) => {
  try {
    const base = { verificationStatus: 'approved' };
    const [specializations, cities, localities, languages] = await Promise.all([
      DoctorProfile.distinct('specialization', base),
      DoctorProfile.distinct('clinicAddress.city', base),
      DoctorProfile.distinct('clinicAddress.locality', base),
      DoctorProfile.distinct('languages', base),
    ]);

    const clean = (items) => items.filter(Boolean).map(String).sort((a, b) => a.localeCompare(b));
    return res.json({
      success: true,
      specializations: clean(specializations),
      cities: clean(cities),
      localities: clean(localities),
      languages: clean(languages),
      consultationTypes: VALID_TYPES,
      sortOptions: ['rating', 'experience', 'fee_low', 'fee_high', 'newest'],
    });
  } catch (err) {
    console.error('Error fetching doctor directory metadata:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch doctor directory metadata' });
  }
};

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

    // Send the flags as the booking side resolves them, so the doctor's
    // settings screen shows the same visit types patients can book.
    const out = doctor.toObject();
    out.clinicConsultationEnabled = getDoctorTypeEnabled(doctor, 'clinic');
    out.homeVisitEnabled = getDoctorTypeEnabled(doctor, 'home');
    out.teleconsultationEnabled = getDoctorTypeEnabled(doctor, 'video');
    return res.json({ success: true, doctor: out });
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
      { $set: updates },
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
      await User.findByIdAndUpdate(doctor.userId, { $set: { email: updates.email } });
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
      setTimeout(async () => {
        try {
          console.log('🔄 Availability changed, updating calendar immediately in background...');
          const result = await updateDoctorInCalendar(doctor._id, doctor);
          if (result.success) {
            console.log(`✅ Calendar updated immediately for ${doctor.name}`);
          }
        } catch (calendarError) {
          console.error('❌ Error updating doctor in calendar:', calendarError);
        }
      }, 500); // Send to background
    }

    return res.json({
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
          // Voided commissions (cancelled/rejected/no_show bookings) are not earnings.
          payoutStatus: { $ne: 'cancelled' },
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
      professionalType: 'doctor',
      // Voided commissions (cancelled/rejected/no_show bookings) are not earnings.
      payoutStatus: { $ne: 'cancelled' }
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
    // Bound to the current day only (previously counted every future day too).
    const endOfToday = new Date(today);
    endOfToday.setHours(23, 59, 59, 999);
    const todaysAppointments = await Appointment.countDocuments({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: today, $lte: endOfToday },
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
          // Voided commissions (cancelled/rejected/no_show bookings) are not earnings.
          payoutStatus: { $ne: 'cancelled' },
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
      { $set: updates },
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
        $set: { email: updates.email }
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

// GET /doctor/patients/:id
exports.getPatientById = async (req, res) => {
  try {
    const PatientProfile = require('../models/PatientProfile');
    const Prescription = require('../models/Prescription');
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, error: 'Patient not found' });
    }

    // Privacy: a doctor may only open patients they have a care relationship
    // with — at least one non-rejected appointment or a prescription issued
    // by this doctor.
    const doctor = await DoctorProfile.findOne({ userId: req.user.id }).select('_id');
    if (!doctor) return res.status(404).json({ success: false, error: 'Doctor profile not found' });

    const [hasAppointment, hasPrescription] = await Promise.all([
      Appointment.exists({ doctorId: doctor._id, patientId: req.params.id, status: { $ne: 'rejected' } }),
      Prescription.exists({ doctorId: doctor._id, patientId: req.params.id })
    ]);
    if (!hasAppointment && !hasPrescription) {
      return res.status(403).json({ success: false, error: 'You can only view patients who have an appointment or prescription with you' });
    }

    const profile = await PatientProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ success: false, error: 'Patient not found' });
    return res.json(profile);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};