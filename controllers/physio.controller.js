// controllers/physio.controller.js
const mongoose = require('mongoose');

const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const User = require('../models/User');
const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const Commission = require('../models/Commission');

// updateDoctorInCalendar is intentionally NOT imported: it looks the id up in
// DoctorProfile, so calling it with a physio id did nothing useful. Physio
// slots are now generated straight from profile.availability (see below).
const { initializeCalendarForMonth } = require('../jobs/calendarJob');
const {
  getConsultationTypes,
  getDoctorTypeEnabled,
  getDoctorDailySlots,
  PROFESSIONAL_SETTINGS,
} = require('../services/doctorAvailability.service');

const PHYSIO_DEFAULTS = PROFESSIONAL_SETTINGS.physio;

// Visit-type flags as the booking side resolves them (missing optional flag =
// derive from fee), so screens show exactly what patients can book.
const withResolvedFlags = (out, physio) => {
  out.clinicConsultationEnabled = getDoctorTypeEnabled(physio, 'clinic');
  out.homeVisitEnabled = getDoctorTypeEnabled(physio, 'home');
  out.teleconsultationEnabled = getDoctorTypeEnabled(physio, 'video');
  return out;
};

const AVAILABILITY_FIELDS =
  'name availability consultationFee homeVisitFee videoCallFee clinicConsultationEnabled homeVisitEnabled teleconsultationEnabled slotDurationMinutes bookingWindowDays minimumNoticeMinutes verificationStatus';

// ---------- helpers ----------
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

const normalizePhone = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

const normalizeClinicAddress = (addr = {}) => ({
  address: addr.address || addr.street || '',
  city: addr.city || '',
  state: addr.state || '',
  pincode: addr.pincode || '',
  location:
    addr.location && Array.isArray(addr.location.coordinates)
      ? addr.location
      : { type: 'Point', coordinates: [0, 0] }
});

const defaultAvailability = [
  { day: 'monday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'tuesday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'wednesday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'thursday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'friday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] }
];

const dateKeyLocal = (d) => {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const dd = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

const timeToMinutes = (t) => {
  const [hh, mm] = String(t || '00:00').split(':').map(Number);
  return hh * 60 + mm;
};

const minutesToHHMM = (mins) => {
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
};

// ========== PUBLIC / ME FUNCTIONS ==========

// ✅ Create current physio profile (Physio only)  POST /physio/me/profile
exports.createPhysiotherapist = async (req, res) => {
  try {
    const existing = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Physiotherapist profile already exists',
        physio: existing
      });
    }

    const user = await User.findById(req.user.id);
    const body = req.body || {};

    const contactNumber = body.contactNumber || body.phone || '';
    const email = req.user?.email || body.email || '';

    const specialization = Array.isArray(body.specialization)
      ? body.specialization.filter(Boolean)
      : typeof body.specialization === 'string'
        ? body.specialization.split(',').map(s => s.trim()).filter(Boolean)
        : ['General Physiotherapy'];

    const consultationFee = Number(body.consultationFee);
    const homeVisitFee = body.homeVisitFee !== undefined ? Number(body.homeVisitFee) : 0;
    const videoCallFee = body.videoCallFee !== undefined ? Number(body.videoCallFee) : 0;

    const experienceYears =
      body.experienceYears !== undefined ? Number(body.experienceYears)
      : body.experience !== undefined ? Number(body.experience)
      : 0;

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

    // required fields
    if (!body.name) return res.status(400).json({ success: false, error: 'name is required' });
    if (!specialization.length) return res.status(400).json({ success: false, error: 'specialization is required' });
    if (!body.licenseNumber) return res.status(400).json({ success: false, error: 'licenseNumber is required' });
    if (Number.isNaN(consultationFee)) return res.status(400).json({ success: false, error: 'consultationFee is required' });

    const qualifications = Array.isArray(body.qualifications)
      ? body.qualifications.map(q => ({
          degree: q.degree || '',
          university: q.university || '',
          year: q.year !== undefined && q.year !== null && q.year !== '' ? Number(q.year) : undefined,
          certificateUrl: q.certificateUrl || ''
        }))
      : [];

    const availability = Array.isArray(body.availability) ? body.availability : defaultAvailability;

    const newPhysio = await PhysiotherapistProfile.create({
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
      servesAreas: Array.isArray(body.servesAreas) ? body.servesAreas : [],

      consultationFee,
      homeVisitFee: Number.isNaN(homeVisitFee) ? 0 : homeVisitFee,
      videoCallFee: Number.isNaN(videoCallFee) ? 0 : videoCallFee,

      availability,

      languages: Array.isArray(body.languages) ? body.languages : (body.languages ? [body.languages] : ['English']),
      about: body.about || '',
      services: Array.isArray(body.services) ? body.services : [],

      contactNumber: contactNumber || normalizePhone(user?.phone),
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

    user.profileId = newPhysio._id;
    await user.save();

    // Best-effort calendar sync
    try {
      await addPhysioToCalendar(newPhysio);
    } catch (calendarError) {
      console.error('❌ Failed to update calendar with new physio:', calendarError);
    }

    return res.status(201).json({
      success: true,
      message: 'Physiotherapist profile created successfully. Pending admin verification.',
      physio: newPhysio
    });
  } catch (err) {
    console.error('Physio creation error:', err);
    return res.status(400).json({ success: false, error: err.message });
  }
};

// Get all physios (public)  GET /physio
exports.getAllPhysios = async (req, res) => {
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

    // Public route (no auth): always approved only. The verificationStatus
    // query param used to be honoured, which let anyone list pending/rejected
    // physios; admins review those through the admin endpoints instead.
    void verificationStatus;
    filter.verificationStatus = 'approved';

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

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const physios = await PhysiotherapistProfile.find(filter)
      .select(
        'name profileImage gender specialization qualifications experienceYears clinicAddress consultationFee homeVisitFee videoCallFee clinicConsultationEnabled homeVisitEnabled teleconsultationEnabled languages about services verificationStatus averageRating totalReviews totalConsultations servesAreas availability'
      )
      // Public listing: never the account's email.
      .populate('userId', 'isVerified')
      .sort({ averageRating: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await PhysiotherapistProfile.countDocuments(filter);

    return res.json({
      success: true,
      physios,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (err) {
    console.error('Error fetching physios:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch physiotherapists' });
  }
};

// Get physio by ID (public)  GET /physio/:id
exports.getPhysioById = async (req, res) => {
  try {
    const { id } = req.params;

    // ✅ Prevent "service-areas" etc from being treated as ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid physiotherapist id'
      });
    }

    const physio = await PhysiotherapistProfile.findById(id)
      .select('-bankDetails -licenseDocument -adminNotes -commissionRate -pendingCommission -paidCommission')
      .populate('userId', 'isVerified');

    if (!physio) {
      return res.status(404).json({ success: false, error: 'Physiotherapist not found' });
    }

    const upcomingAppointments = await Appointment.find({
      physioId: physio._id,
      professionalType: 'physio',
      appointmentDate: { $gte: new Date() },
      status: { $in: ['confirmed', 'accepted'] }
    })
      .select('appointmentDate startTime type')
      .sort({ appointmentDate: 1 })
      .limit(5);

    return res.json({
      success: true,
      physio: { ...physio.toObject(), upcomingAppointments }
    });
  } catch (err) {
    console.error('Error fetching physio:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch physiotherapist details' });
  }
};

// Get physios by specialization (public)  GET /physio/specialization/:specialization
exports.getPhysiosBySpecialization = async (req, res) => {
  try {
    const { specialization } = req.params;
    const { city, minRating, maxFee, page = 1, limit = 20 } = req.query;

    const filter = { verificationStatus: 'approved' };

    if (specialization !== 'all') filter.specialization = { $in: [specialization] };
    if (city) filter['clinicAddress.city'] = { $regex: city, $options: 'i' };
    if (minRating) filter.averageRating = { $gte: parseFloat(minRating) };
    if (maxFee) filter.consultationFee = { $lte: parseFloat(maxFee) };

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const physios = await PhysiotherapistProfile.find(filter)
      .select('name profileImage specialization averageRating consultationFee homeVisitFee videoCallFee clinicAddress availability totalConsultations servesAreas')
      .sort({ averageRating: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await PhysiotherapistProfile.countDocuments(filter);

    return res.json({
      success: true,
      specialization,
      count: physios.length,
      physios,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (err) {
    console.error('Error fetching physios by specialization:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch physiotherapists' });
  }
};

// Weekly availability template (public)  GET /physio/:id/availability/weekly
// Same response shape as GET /doctor/:id/availability/weekly (physioName is
// kept for older clients; doctorName is the shared key).
exports.getWeeklyAvailability = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid physiotherapist id' });
    }

    const physio = await PhysiotherapistProfile.findOne({ _id: id, verificationStatus: 'approved' })
      .select(AVAILABILITY_FIELDS);

    if (!physio) {
      return res.status(404).json({ success: false, error: 'Physiotherapist not found' });
    }

    return res.json({
      success: true,
      availability: physio.availability || [],
      doctorName: physio.name,
      physioName: physio.name,
      consultationFee: physio.consultationFee,
      homeVisitFee: physio.homeVisitFee,
      videoCallFee: physio.videoCallFee,
      clinicConsultationEnabled: getDoctorTypeEnabled(physio, 'clinic'),
      homeVisitEnabled: getDoctorTypeEnabled(physio, 'home'),
      teleconsultationEnabled: getDoctorTypeEnabled(physio, 'video'),
      consultationTypes: getConsultationTypes(physio),
      slotDurationMinutes: physio.slotDurationMinutes || PHYSIO_DEFAULTS.slotDurationMinutes,
      bookingWindowDays: physio.bookingWindowDays || PHYSIO_DEFAULTS.bookingWindowDays,
      minimumNoticeMinutes: physio.minimumNoticeMinutes || 60,
    });
  } catch (err) {
    console.error('Error fetching weekly availability:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch weekly availability' });
  }
};

// Date availability (public)  GET /physio/:id/availability?date=YYYY-MM-DD&type=clinic|home|video
// Bookable slots generated from profile.availability by the shared slot
// service - same response shape as GET /doctor/:id/availability. (It used to
// read Calendar working-hour blocks, which were never populated for physios.)
exports.getPhysioAvailability = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid physiotherapist id' });
    }

    const physio = await PhysiotherapistProfile.findOne({ _id: id, verificationStatus: 'approved' })
      .select(AVAILABILITY_FIELDS + ' userId')
      .populate('userId', 'isVerified isActive');

    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist not found' });

    if (physio.userId && (!physio.userId.isVerified || physio.userId.isActive === false)) {
      return res.status(400).json({ success: false, error: 'Physiotherapist is not available for appointments' });
    }

    const daily = await getDoctorDailySlots(physio, req.query.date || new Date(), {
      type: req.query.type || 'clinic',
      duration: req.query.duration,
      includeUnavailable: req.query.includeUnavailable === 'true',
      professionalType: 'physio',
    });

    return res.json({
      success: true,
      ...daily,
      availableSlots: daily.slots.filter((slot) => slot.isAvailable !== false),
      doctorName: physio.name,
      physioName: physio.name,
      consultationFee: physio.consultationFee,
      homeVisitFee: physio.homeVisitFee,
      videoCallFee: physio.videoCallFee,
      consultationTypes: getConsultationTypes(physio),
    });
  } catch (err) {
    console.error('Error fetching physio availability:', err.message);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.statusCode ? err.message : 'Failed to fetch availability',
    });
  }
};

// ========== PHYSIO (ME) FUNCTIONS ==========

// GET /physio/me/profile
exports.getProfile = async (req, res) => {
  try {
    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .populate('userId', 'email isVerified lastLogin');

    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    // Send the flags as the booking side resolves them (like doctor getProfile).
    return res.json({ success: true, physio: withResolvedFlags(physio.toObject(), physio) });
  } catch (err) {
    console.error('Error fetching physio profile:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
};

// PUT /physio/me/profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };

    if (updates.phone && !updates.contactNumber) {
      updates.contactNumber = updates.phone;
      delete updates.phone;
    }

    if (updates.clinicAddress?.street && !updates.clinicAddress.address) {
      updates.clinicAddress.address = updates.clinicAddress.street;
      delete updates.clinicAddress.street;
    }

    if (updates.contactNumber) updates.contactNumber = normalizePhone(updates.contactNumber);
    if (updates.clinicAddress) updates.clinicAddress = normalizeClinicAddress(updates.clinicAddress);

    const currentPhysio = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!currentPhysio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    // Whitelist instead of `$set` on the raw body: only these fields are
    // self-editable. verificationStatus, commissionRate, userId, earnings,
    // ratings and admin fields can never be changed here. The licence can
    // only be edited while the profile is not yet approved (admins re-verify
    // otherwise).
    const editable = [
      'name', 'profileImage', 'gender', 'dateOfBirth', 'specialization', 'qualifications',
      'experienceYears', 'clinicAddress', 'servesAreas', 'consultationFee', 'homeVisitFee',
      'videoCallFee', 'clinicConsultationEnabled', 'homeVisitEnabled', 'teleconsultationEnabled',
      'slotDurationMinutes', 'bookingWindowDays', 'minimumNoticeMinutes', 'availability',
      'services', 'languages', 'about', 'contactNumber', 'emergencyContact', 'email', 'bankDetails',
    ];
    if (currentPhysio.verificationStatus !== 'approved') editable.push('licenseNumber', 'licenseDocument');
    Object.keys(updates).forEach((key) => {
      if (!editable.includes(key)) delete updates[key];
    });

    const physio = await PhysiotherapistProfile.findOneAndUpdate(
      { userId: req.user.id },
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('userId', 'email');

    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    if (updates.email && physio.userId) {
      await User.findByIdAndUpdate(physio.userId, { $set: { email: updates.email } });
    }

    // No calendar sync needed on availability change: physio slots are read
    // live from profile.availability by the availability endpoints/booking.

    return res.json({ success: true, message: 'Profile updated successfully', physio });
  } catch (err) {
    console.error('Error updating physio profile:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
};

// PUT /physio/me/availability
exports.updateAvailability = async (req, res) => {
  try {
    const { availability } = req.body;

    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    physio.availability = availability;
    await physio.save();

    // No calendar sync: physio slots are generated live from
    // profile.availability (updateDoctorInCalendar only handles doctors).

    return res.json({ success: true, message: 'Availability updated successfully', availability: physio.availability });
  } catch (err) {
    console.error('Error updating availability:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
};

// POST /physio/me/break
exports.addBreak = async (req, res) => {
  try {
    const { date, startTime, endTime, reason } = req.body || {};
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'Date, startTime, and endTime are required' });
    }

    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const breakDate = new Date(date);
    if (Number.isNaN(breakDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }

    const year = breakDate.getFullYear();
    const month = breakDate.getMonth() + 1;
    const dateStr = breakDate.toISOString().split('T')[0];

    let calendar = await Calendar.findOne({ year, month });
    if (!calendar && typeof initializeCalendarForMonth === 'function') {
      calendar = await initializeCalendarForMonth(year, month);
    }
    if (!calendar) calendar = new Calendar({ year, month, days: [] });

    let day = calendar.days.find(d => new Date(d.date).toISOString().split('T')[0] === dateStr);
    if (!day) {
      const dayName = breakDate.toLocaleDateString('en-US', { weekday: 'long' });
      day = { date: breakDate, dayName, isHoliday: false, professionals: [] };
      calendar.days.push(day);
    }

    let professional = day.professionals.find(
      p => p.professionalId.toString() === profile._id.toString() && p.professionalType === 'physio'
    );

    if (!professional) {
      const dayNameLower = breakDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const dayAvailability = profile.availability?.find(a => a.day === dayNameLower);

      const workingHours = (dayAvailability?.slots || []).map(slot => ({
        startTime: slot.startTime,
        endTime: slot.endTime
      }));

      professional = {
        professionalId: profile._id,
        professionalType: 'physio',
        bookedSlots: [],
        breaks: [],
        workingHours,
        isAvailable: true
      };
      day.professionals.push(professional);
    }

    professional.breaks.push({ startTime, endTime, reason: reason || 'Break' });

    await calendar.save();

    return res.json({
      success: true,
      message: 'Break added successfully',
      break: { date: dateStr, startTime, endTime, reason: reason || 'Break' }
    });
  } catch (error) {
    console.error('Error adding break:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to add break' });
  }
};

// GET /physio/me/appointments
exports.getAppointments = async (req, res) => {
  try {
    const { status, type, startDate, endDate, page = 1, limit = 20 } = req.query;

    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    const filter = { physioId: physio._id, professionalType: 'physio' };
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) filter.appointmentDate = { $gte: new Date(startDate), $lte: new Date(endDate) };

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('referralId', 'requirement')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await Appointment.countDocuments(filter);

    return res.json({
      success: true,
      appointments,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        pages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (err) {
    console.error('Error fetching appointments:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch appointments' });
  }
};

// GET /physio/me/patients
exports.getMyPatients = async (req, res) => {
  try {
    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    // Find all appointments for this physio
    const appointments = await Appointment.find({
      physioId: physio._id,
      professionalType: 'physio'
    })
      .populate('patientId', 'name phone email age gender bloodGroup weight height address chronicConditions')
      .sort({ appointmentDate: -1 });

    // Group by patient and compute stats
    const patientMap = {};
    for (const apt of appointments) {
      if (!apt.patientId?._id) continue;
      const pid = apt.patientId._id.toString();
      if (!patientMap[pid]) {
        const p = apt.patientId.toObject ? apt.patientId.toObject() : apt.patientId;
        patientMap[pid] = {
          ...p,
          totalVisits: 0,
          lastVisit: null,
          totalPrescriptions: 0,
          activeTreatments: 0,
          registeredAt: apt.createdAt
        };
      }
      patientMap[pid].totalVisits += 1;
      const aptDate = new Date(apt.appointmentDate);
      if (!patientMap[pid].lastVisit || aptDate > new Date(patientMap[pid].lastVisit)) {
        patientMap[pid].lastVisit = apt.appointmentDate;
      }
      if (apt.status === 'confirmed' || apt.status === 'accepted') {
        patientMap[pid].activeTreatments += 1;
      }
    }

    const patients = Object.values(patientMap);

    return res.json({ success: true, patients });
  } catch (err) {
    console.error('Error fetching physio patients:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch patients' });
  }
};

// GET /physio/me/patients/:id
exports.getPatientById = async (req, res) => {
  try {
    const PatientProfile = require('../models/PatientProfile');
    const Prescription = require('../models/Prescription');
    const PhysioExercisePlan = require('../models/PhysioExercisePlan');
    if (!isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, error: 'Patient not found' });
    }

    // Privacy (mirrors doctor getPatientById): a physio may only open patients
    // they have a care relationship with - a non-rejected appointment, an
    // exercise plan, or a prescription from this physio.
    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id }).select('_id');
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    const [hasAppointment, hasPlan, hasPrescription] = await Promise.all([
      Appointment.exists({ physioId: physio._id, patientId: req.params.id, status: { $ne: 'rejected' } }),
      PhysioExercisePlan.exists({ physioId: physio._id, patientId: req.params.id }),
      Prescription.exists({ physioId: physio._id, patientId: req.params.id })
    ]);
    if (!hasAppointment && !hasPlan && !hasPrescription) {
      return res.status(403).json({ success: false, error: 'You can only view patients who have an appointment, exercise plan or prescription with you' });
    }

    const profile = await PatientProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ success: false, error: 'Patient not found' });
    return res.json(profile);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// GET /physio/me/earnings
exports.getEarnings = async (req, res) => {
  try {
    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .select('totalEarnings pendingCommission paidCommission totalConsultations');

    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: physio._id,
          professionalType: 'physio',
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

    return res.json({
      success: true,
      earnings: {
        totalEarnings: physio.totalEarnings || 0,
        pendingCommission: physio.pendingCommission || 0,
        paidCommission: physio.paidCommission || 0,
        monthlyEarnings: monthlyEarnings[0]?.totalEarnings || 0,
        monthlyCommission: monthlyEarnings[0]?.totalCommission || 0
      },
      stats: { totalConsultations: physio.totalConsultations || 0 }
    });
  } catch (err) {
    console.error('Error fetching earnings:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch earnings data' });
  }
};

// GET /physio/me/earnings/report
exports.getPhysioEarnings = async (req, res) => {
  try {
    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    const { startDate, endDate, groupBy = 'month' } = req.query;

    const matchStage = {
      professionalId: physio._id,
      professionalType: 'physio',
      // Voided commissions (cancelled/rejected/no_show bookings) are not earnings.
      payoutStatus: { $ne: 'cancelled' }
    };

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      matchStage.createdAt = { $gte: start, $lte: end };
    }

    const earnings = await Commission.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:
            groupBy === 'month'
              ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }
              : { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } },
          totalEarnings: { $sum: '$professionalEarning' },
          totalCommission: { $sum: '$platformCommission' },
          appointmentCount: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1, '_id.day': -1 } }
    ]);

    const pendingCommission = await Commission.aggregate([
      {
        $match: {
          professionalId: physio._id,
          professionalType: 'physio',
          payoutStatus: 'pending'
        }
      },
      { $group: { _id: null, total: { $sum: '$professionalEarning' }, count: { $sum: 1 } } }
    ]);

    return res.json({
      success: true,
      earnings,
      pendingCommission: pendingCommission[0]?.total || 0,
      profileStats: {
        totalEarnings: physio.totalEarnings || 0,
        pendingCommission: physio.pendingCommission || 0,
        paidCommission: physio.paidCommission || 0
      }
    });
  } catch (err) {
    console.error('Error fetching earnings report:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch earnings report' });
  }
};

// GET /physio/me/dashboard
exports.getPhysioDashboard = async (req, res) => {
  try {
    const physio = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .select('name specialization averageRating totalConsultations totalEarnings');

    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist profile not found' });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Bound to today only (it previously counted every future appointment).
    const endOfToday = new Date(today);
    endOfToday.setHours(23, 59, 59, 999);
    const todaysAppointments = await Appointment.countDocuments({
      physioId: physio._id,
      professionalType: 'physio',
      appointmentDate: { $gte: today, $lte: endOfToday },
      status: { $in: ['confirmed', 'accepted'] }
    });

    const pendingAppointments = await Appointment.countDocuments({
      physioId: physio._id,
      professionalType: 'physio',
      status: 'pending'
    });

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: physio._id,
          professionalType: 'physio',
          // Voided commissions (cancelled/rejected/no_show bookings) are not earnings.
          payoutStatus: { $ne: 'cancelled' },
          createdAt: { $gte: startOfMonth }
        }
      },
      { $group: { _id: null, total: { $sum: '$professionalEarning' } } }
    ]);

    const recentAppointments = await Appointment.find({
      physioId: physio._id,
      professionalType: 'physio'
    })
      .populate('patientId', 'name')
      .sort({ appointmentDate: -1 })
      .limit(5);

    return res.json({
      success: true,
      stats: {
        totalConsultations: physio.totalConsultations || 0,
        totalEarnings: physio.totalEarnings || 0,
        averageRating: physio.averageRating || 0,
        todaysAppointments,
        pendingAppointments,
        monthlyEarnings: monthlyEarnings[0]?.total || 0
      },
      recentAppointments,
      profile: { name: physio.name, specialization: physio.specialization }
    });
  } catch (err) {
    console.error('Error fetching physio dashboard:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
};

// ========== ADMIN-ONLY FUNCTIONS ==========

// PUT /physio/:id
exports.updatePhysio = async (req, res) => {
  try {
    const physioId = req.params.id;
    if (!isValidObjectId(physioId)) {
      return res.status(400).json({ success: false, error: 'Invalid physiotherapist id' });
    }

    const updates = req.body || {};
    delete updates.totalEarnings;
    delete updates.totalConsultations;
    delete updates.pendingCommission;
    delete updates.paidCommission;

    const physio = await PhysiotherapistProfile.findByIdAndUpdate(physioId, { $set: updates }, {
      new: true,
      runValidators: true
    }).populate('userId', 'email');

    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist not found' });

    if (updates.email && physio.userId) {
      await User.findByIdAndUpdate(physio.userId, { $set: { email: updates.email } });
    }

    // No calendar sync on availability change: physio slots are generated
    // live from profile.availability (updateDoctorInCalendar is doctor-only).

    return res.json({ success: true, message: 'Physiotherapist updated successfully', physio });
  } catch (err) {
    console.error('Error updating physio:', err.message);
    return res.status(400).json({ success: false, error: err.message });
  }
};

// DELETE /physio/:id
exports.deletePhysio = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid physiotherapist id' });
    }

    const physio = await PhysiotherapistProfile.findById(id);
    if (!physio) return res.status(404).json({ success: false, error: 'Physiotherapist not found' });

    const upcomingAppointments = await Appointment.countDocuments({
      physioId: physio._id,
      professionalType: 'physio',
      appointmentDate: { $gte: new Date() },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    });

    if (upcomingAppointments > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete physiotherapist with upcoming appointments. Cancel appointments first.'
      });
    }

    try {
      await removePhysioFromCalendar(physio._id);
    } catch (calendarError) {
      console.error('Error removing physio from calendar:', calendarError);
    }

    if (physio.userId) await User.findByIdAndDelete(physio.userId);
    await PhysiotherapistProfile.findByIdAndDelete(id);

    return res.json({ success: true, message: 'Physiotherapist deleted successfully' });
  } catch (err) {
    console.error('Error deleting physio:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete physiotherapist' });
  }
};

// POST /physio/bulk
exports.bulkCreatePhysios = async (req, res) => {
  const physiosData = req.body;

  if (!physiosData || !Array.isArray(physiosData)) {
    return res.status(400).json({ success: false, error: 'Invalid data format. Expected an array.' });
  }

  const successfulImports = [];
  const failedImports = [];

  for (const physioData of physiosData) {
    try {
      const userExists = await User.findOne({ email: physioData.email });
      if (userExists) throw new Error('User with this email already exists.');

      const newUser = await User.create({
        name: physioData.name,
        email: physioData.email,
        password: physioData.password || 'temporary123',
        role: 'physio',
        phone: physioData.phone
      });

      const newPhysio = await PhysiotherapistProfile.create({
        userId: newUser._id,
        name: physioData.name,
        email: physioData.email,
        contactNumber: physioData.phone,
        specialization: physioData.specialization || ['General Physiotherapy'],
        qualifications: physioData.qualifications || [],
        experienceYears: physioData.experienceYears || 0,
        licenseNumber: physioData.licenseNumber,
        clinicAddress: {
          address: physioData.address || '',
          city: physioData.city || '',
          state: physioData.state || '',
          pincode: physioData.pincode || '',
          location: physioData.location || { type: 'Point', coordinates: [0, 0] }
        },
        consultationFee: physioData.consultationFee || 0,
        homeVisitFee: physioData.homeVisitFee || 0,
        availability: physioData.availability || [],
        about: physioData.about || '',
        services: physioData.services || [],
        gender: physioData.gender,
        dateOfBirth: physioData.dateOfBirth ? new Date(physioData.dateOfBirth) : null,
        bankDetails: physioData.bankDetails,
        commissionRate: physioData.commissionRate || 20
      });

      try {
        await addPhysioToCalendar(newPhysio);
      } catch (calendarError) {
        console.error('Error adding physio to calendar during bulk import:', calendarError);
      }

      successfulImports.push({ id: newPhysio._id, name: newPhysio.name, email: newPhysio.email });
    } catch (err) {
      failedImports.push({ email: physioData.email, reason: err.message });
    }
  }

  return res.status(201).json({
    success: true,
    message: 'Bulk import process completed.',
    successfulCount: successfulImports.length,
    failedCount: failedImports.length,
    successfulImports,
    failedImports
  });
};

// ========== HELPER FUNCTIONS (calendar) ==========

async function addPhysioToCalendar(physio) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const datesToUpdate = [];
  for (let i = 0; i <= 30; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    date.setHours(0, 0, 0, 0);
    datesToUpdate.push(date);
  }

  const targetDate = new Date();
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;

  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) calendar = new Calendar({ year, month, days: [] });

  let needsUpdate = false;

  for (const targetDateItem of datesToUpdate) {
    const dateStr = targetDateItem.toISOString().split('T')[0];
    const dayName = targetDateItem.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    const dayAvailability = physio.availability?.find(a => a.day === dayName);
    if (!dayAvailability) continue;

    const existingDayIndex = calendar.days.findIndex(
      d => new Date(d.date).toISOString().split('T')[0] === dateStr
    );

    const workingHours = (dayAvailability.slots || []).map(slot => ({
      startTime: slot.startTime,
      endTime: slot.endTime
    }));

    if (existingDayIndex !== -1) {
      const existingDay = calendar.days[existingDayIndex];
      const isAlreadyAdded = (existingDay.professionals || []).some(
        p => p.professionalId.toString() === physio._id.toString() && p.professionalType === 'physio'
      );

      if (!isAlreadyAdded) {
        needsUpdate = true;
        existingDay.professionals.push({
          professionalId: physio._id,
          professionalType: 'physio',
          bookedSlots: [],
          breaks: [],
          workingHours,
          isAvailable: true
        });
      }
    } else {
      needsUpdate = true;
      calendar.days.push({
        date: targetDateItem,
        dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        isHoliday: false,
        professionals: [
          {
            professionalId: physio._id,
            professionalType: 'physio',
            bookedSlots: [],
            breaks: [],
            workingHours,
            isAvailable: true
          }
        ]
      });
    }
  }

  if (needsUpdate) {
    const base = new Date(today);

    calendar.days = calendar.days.filter(day => {
      const dayDate = new Date(day.date);
      const diffDays = Math.floor((dayDate - base) / (1000 * 60 * 60 * 24));
      return diffDays >= 0 && diffDays <= 30;
    });

    calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
    await calendar.save();
  }
}

async function removePhysioFromCalendar(physioId) {
  const calendars = await Calendar.find({
    'days.professionals.professionalId': physioId
  });

  for (const calendar of calendars) {
    let updated = false;

    for (const day of calendar.days || []) {
      const initialLength = (day.professionals || []).length;
      day.professionals = (day.professionals || []).filter(
        p => !(p.professionalId.toString() === physioId.toString() && p.professionalType === 'physio')
      );
      if ((day.professionals || []).length !== initialLength) updated = true;
    }

    calendar.days = (calendar.days || []).filter(day => (day.professionals || []).length > 0);

    if (updated) await calendar.save();
  }
}