// controllers/physio.controller.js (UPDATED to match PhysiotherapistProfile schema)

const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const Appointment = require('../models/Appointment');
const Commission = require('../models/Commission');
const Calendar = require('../models/Calendar');
const User = require('../models/User');

// ---------- helpers ----------
const safeDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

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

// availabilitySlotSchema is shared with DoctorProfile.
// Your DB expects: [{ day: 'monday', slots: [{ startTime, endTime, type, maxPatients? }] }]
const defaultAvailability = [
  { day: 'monday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'tuesday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'wednesday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'thursday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] },
  { day: 'friday', slots: [{ startTime: '09:00', endTime: '17:00', type: 'clinic' }] }
];

// ========== CREATE PROFILE (admin or self) ==========
// Route in your router: POST /physio  => createPhysiotherapist
exports.createPhysiotherapist = async (req, res) => {
  try {
    const body = req.body || {};

    // You were passing userId in body, but your app also uses protect() -> req.user.id.
    // We'll support BOTH:
    const targetUserId = body.userId || req.user?.id;
    if (!targetUserId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const existingProfile = await PhysiotherapistProfile.findOne({ userId: targetUserId });
    if (existingProfile) {
      return res.status(409).json({
        success: false,
        error: 'Physiotherapist profile already exists for this user',
        profile: existingProfile
      });
    }

    // Required by schema: name, licenseNumber, specialization (each required), consultationFee, homeVisitFee
    const name = (body.name || user.name || '').trim();
    const licenseNumber = (body.licenseNumber || '').trim();
    const specialization =
      Array.isArray(body.specialization) && body.specialization.length
        ? body.specialization
        : ['General Physiotherapy'];

    const consultationFee =
      body.consultationFee !== undefined && body.consultationFee !== ''
        ? Number(body.consultationFee)
        : 500;

    const homeVisitFee =
      body.homeVisitFee !== undefined && body.homeVisitFee !== ''
        ? Number(body.homeVisitFee)
        : 800;

    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    if (!licenseNumber) return res.status(400).json({ success: false, error: 'licenseNumber is required' });
    if (!specialization?.length) return res.status(400).json({ success: false, error: 'specialization is required' });

    // clinicAddress in schema is object; normalize it
    const clinicAddress = normalizeClinicAddress(body.clinicAddress);

    const physioProfile = await PhysiotherapistProfile.create({
      userId: targetUserId,

      name,
      email: (body.email || user.email || '').toLowerCase().trim(),
      contactNumber: normalizePhone(body.phone || user.phone),

      gender: body.gender,
      dateOfBirth: safeDate(body.dateOfBirth),

      specialization,
      qualifications: Array.isArray(body.qualifications) ? body.qualifications : [],
      experienceYears: body.experienceYears !== undefined ? Number(body.experienceYears) : 0,

      licenseNumber,
      licenseDocument: body.licenseDocument, // if you store url/path directly
      clinicAddress,

      servesAreas: Array.isArray(body.servesAreas) ? body.servesAreas : [],

      consultationFee,
      homeVisitFee,

      availability: Array.isArray(body.availability) && body.availability.length ? body.availability : defaultAvailability,

      services: Array.isArray(body.services) ? body.services : [],
      languages: Array.isArray(body.languages) && body.languages.length ? body.languages : ['English'],
      about: body.about || '',

      // leave verificationStatus default = pending unless admin explicitly sets it
      // verificationStatus: body.verificationStatus,

      commissionRate: body.commissionRate !== undefined ? Number(body.commissionRate) : 20,

      bankDetails: body.bankDetails || undefined,
      emergencyContact: body.emergencyContact,
      // totals default in schema
    });

    user.profileId=physioProfile._id;
    user.save();

    // Handle file uploads (kept same)
    if (req.files) {
      const update = {};
      if (req.files.profileImage?.[0]?.path) update.profileImage = req.files.profileImage[0].path;
      if (req.files.licenseDocument?.[0]?.path) update.licenseDocument = req.files.licenseDocument[0].path;
      if (Object.keys(update).length) {
        await PhysiotherapistProfile.findByIdAndUpdate(physioProfile._id, update, { new: true });
      }
    }

    // Ensure user role is physio
    if (user.role !== 'physio') {
      user.role = 'physio';
      await user.save();
    }

    // Optional: add/update calendar for next 30 days using their availability
    try {
      await updateCalendarAvailability(physioProfile._id, 'physio', physioProfile.availability);
    } catch (e) {
      console.error('Calendar update error (createPhysiotherapist):', e.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Physiotherapist profile created successfully',
      profile: await PhysiotherapistProfile.findById(physioProfile._id).populate('userId', 'email isVerified')
    });
  } catch (error) {
    console.error('Error creating physiotherapist:', error);

    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach((key) => (errors[key] = error.errors[key].message));
      return res.status(400).json({ success: false, error: 'Validation failed', errors });
    }

    return res.status(400).json({ success: false, error: error.message });
  }
};

// ========== PHYSIO-ONLY FUNCTIONS ==========

// GET /physio/profile
exports.getProfile = async (req, res) => {
  try {
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .populate('userId', 'email isVerified lastLogin');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    return res.json({ success: true, profile });
  } catch (error) {
    console.error('Error fetching physio profile:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
};

// PUT /physio/profile
exports.updateProfile = async (req, res) => {
  try {
    const updates = { ...(req.body || {}) };

    // Remove fields that shouldn't be updated directly
    delete updates.verificationStatus;
    delete updates.totalEarnings;
    delete updates.averageRating;
    delete updates.totalConsultations;
    delete updates.totalReviews;
    delete updates.pendingCommission;
    delete updates.paidCommission;
    delete updates.userId;
    delete updates.createdAt;
    delete updates.updatedAt;

    // normalize
    if (updates.phone) updates.contactNumber = normalizePhone(updates.phone);
    delete updates.phone;

    if (updates.clinicAddress) updates.clinicAddress = normalizeClinicAddress(updates.clinicAddress);
    if (updates.dateOfBirth) {
      const dob = safeDate(updates.dateOfBirth);
      if (!dob) return res.status(400).json({ success: false, error: 'Invalid dateOfBirth' });
      updates.dateOfBirth = dob;
    }
    if (updates.consultationFee !== undefined) updates.consultationFee = Number(updates.consultationFee);
    if (updates.homeVisitFee !== undefined) updates.homeVisitFee = Number(updates.homeVisitFee);
    if (updates.experienceYears !== undefined) updates.experienceYears = Number(updates.experienceYears);

    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const updatedProfile = await PhysiotherapistProfile.findByIdAndUpdate(
      profile._id,
      updates,
      { new: true, runValidators: true }
    ).populate('userId', 'email isVerified');

    // If email changed, update user
    if (updates.email) {
      await User.findByIdAndUpdate(profile.userId, { email: updates.email });
    }

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      profile: updatedProfile
    });
  } catch (error) {
    console.error('Error updating physio profile:', error.message);

    if (error.name === 'ValidationError') {
      const errors = {};
      Object.keys(error.errors).forEach((key) => (errors[key] = error.errors[key].message));
      return res.status(400).json({ success: false, error: 'Validation failed', errors });
    }

    return res.status(400).json({ success: false, error: error.message });
  }
};

// PUT /physio/availability
exports.updateAvailability = async (req, res) => {
  try {
    const { availability, servesAreas } = req.body || {};

    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const updateData = {};
    if (availability) updateData.availability = availability;
    if (servesAreas) updateData.servesAreas = servesAreas;

    const updatedProfile = await PhysiotherapistProfile.findByIdAndUpdate(
      profile._id,
      updateData,
      { new: true, runValidators: true }
    );

    if (availability) {
      try {
        await updateCalendarAvailability(profile._id, 'physio', availability);
      } catch (calendarError) {
        console.error('Error updating calendar:', calendarError.message);
      }
    }

    return res.json({
      success: true,
      message: 'Availability updated successfully',
      profile: updatedProfile
    });
  } catch (error) {
    console.error('Error updating availability:', error.message);
    return res.status(400).json({ success: false, error: error.message });
  }
};

// POST /physio/break
exports.addBreak = async (req, res) => {
  try {
    const { date, startTime, endTime, reason } = req.body || {};
    if (!date || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Date, startTime, and endTime are required'
      });
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
    if (!calendar) calendar = new Calendar({ year, month, days: [] });

    let day = calendar.days.find(d => new Date(d.date).toISOString().split('T')[0] === dateStr);
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

    let professional = day.professionals.find(
      p => p.professionalId.toString() === profile._id.toString() &&
           p.professionalType === 'physio'
    );

    if (!professional) {
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
        bookedSlots,
        breaks: [],
        isAvailable: true
      };
      day.professionals.push(professional);
    }

    professional.breaks.push({
      startTime,
      endTime,
      reason: reason || 'Break'
    });

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

// GET /physio/appointments
exports.getAppointments = async (req, res) => {
  try {
    const { status, type, startDate, endDate, page = 1, limit = 20 } = req.query;

    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    // IMPORTANT FIX:
    // Your Appointment professionalType values elsewhere are: 'doctor' and 'physio'
    // Keep it consistent: use 'physio' here.
    const filter = {
      physioId: profile._id,
      professionalType: 'physio'
    };

    if (status) filter.status = status;
    if (type) filter.type = type;
    if (startDate && endDate) {
      filter.appointmentDate = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const appointments = await Appointment.find(filter)
      .populate('patientId', 'name phone age gender')
      .populate('referralId', 'requirement')
      .sort({ appointmentDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Appointment.countDocuments(filter);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todaysAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physio',
      appointmentDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    });

    const upcomingAppointments = await Appointment.find({
      physioId: profile._id,
      professionalType: 'physio',
      appointmentDate: { $gte: today },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    })
      .populate('patientId', 'name phone')
      .sort({ appointmentDate: 1 })
      .limit(5);

    return res.json({
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
    return res.status(500).json({ success: false, error: 'Failed to fetch appointments' });
  }
};

// GET /physio/earnings
exports.getEarnings = async (req, res) => {
  try {
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .select('totalEarnings pendingCommission paidCommission totalConsultations');

    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: profile._id,
          professionalType: 'physio',
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
        totalEarnings: profile.totalEarnings || 0,
        pendingCommission: profile.pendingCommission || 0,
        paidCommission: profile.paidCommission || 0,
        monthlyEarnings: monthlyEarnings[0]?.totalEarnings || 0,
        monthlyCommission: monthlyEarnings[0]?.totalCommission || 0
      },
      stats: { totalConsultations: profile.totalConsultations || 0 }
    });
  } catch (error) {
    console.error('Error fetching earnings:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch earnings data' });
  }
};

// GET /physio/earnings/report
exports.getEarningsReport = async (req, res) => {
  try {
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const { startDate, endDate, groupBy = 'month' } = req.query;

    const matchStage = {
      professionalId: profile._id,
      professionalType: 'physio'
    };

    if (startDate && endDate) {
      matchStage.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const earnings = await Commission.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:
            groupBy === 'month'
              ? { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } }
              : {
                  year: { $year: '$createdAt' },
                  month: { $month: '$createdAt' },
                  day: { $dayOfMonth: '$createdAt' }
                },
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
          professionalId: profile._id,
          professionalType: 'physio',
          payoutStatus: 'pending'
        }
      },
      { $group: { _id: null, total: { $sum: '$platformCommission' }, count: { $sum: 1 } } }
    ]);

    return res.json({
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
    return res.status(500).json({ success: false, error: 'Failed to fetch earnings report' });
  }
};

// GET /physio/dashboard
exports.getDashboardStats = async (req, res) => {
  try {
    const profile = await PhysiotherapistProfile.findOne({ userId: req.user.id })
      .select('name services averageRating totalConsultations totalEarnings servesAreas');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todaysAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physio',
      appointmentDate: { $gte: today, $lt: tomorrow },
      status: { $in: ['confirmed', 'accepted'] }
    });

    const pendingAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physio',
      status: 'pending'
    });

    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);

    const weeklyAppointments = await Appointment.countDocuments({
      physioId: profile._id,
      professionalType: 'physio',
      appointmentDate: { $gte: startOfWeek, $lte: endOfWeek },
      status: { $in: ['confirmed', 'accepted', 'completed'] }
    });

    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthlyEarnings = await Commission.aggregate([
      {
        $match: {
          professionalId: profile._id,
          professionalType: 'physio',
          createdAt: { $gte: startOfMonth }
        }
      },
      { $group: { _id: null, total: { $sum: '$professionalEarning' } } }
    ]);

    const recentAppointments = await Appointment.find({
      physioId: profile._id,
      professionalType: 'physio'
    })
      .populate('patientId', 'name age gender')
      .sort({ appointmentDate: -1 })
      .limit(5);

    const threeDaysLater = new Date(today);
    threeDaysLater.setDate(today.getDate() + 3);

    const upcomingAppointments = await Appointment.find({
      physioId: profile._id,
      professionalType: 'physio',
      appointmentDate: { $gte: today, $lte: threeDaysLater },
      status: { $in: ['confirmed', 'accepted', 'pending'] }
    })
      .populate('patientId', 'name phone')
      .sort({ appointmentDate: 1 })
      .limit(10);

    return res.json({
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
    return res.status(500).json({ success: false, error: 'Failed to fetch dashboard data' });
  }
};

// ========== HELPER: calendar availability sync ==========
async function updateCalendarAvailability(professionalId, professionalType, availability) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const datesToUpdate = [];
  for (let i = 0; i <= 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    d.setHours(0, 0, 0, 0);
    datesToUpdate.push(d);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) calendar = new Calendar({ year, month, days: [] });

  let updated = false;

  for (const targetDate of datesToUpdate) {
    const dateStr = targetDate.toISOString().split('T')[0];
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayAvailability = availability?.find((a) => a.day === dayName);

    const existingDayIndex = calendar.days.findIndex(
      (d) => new Date(d.date).toISOString().split('T')[0] === dateStr
    );

    if (existingDayIndex !== -1) {
      const day = calendar.days[existingDayIndex];
      const professionalIndex = day.professionals.findIndex(
        (p) =>
          p.professionalId.toString() === professionalId.toString() &&
          p.professionalType === professionalType
      );

      if (professionalIndex !== -1) {
        if (!dayAvailability) {
          day.professionals.splice(professionalIndex, 1);
          updated = true;
        } else {
          day.professionals[professionalIndex].bookedSlots = dayAvailability.slots.map((slot) => ({
            startTime: slot.startTime,
            endTime: slot.endTime,
            isBooked: false,
            type: slot.type || 'clinic'
          }));
          updated = true;
        }
      } else if (dayAvailability) {
        day.professionals.push({
          professionalId,
          professionalType,
          bookedSlots: dayAvailability.slots.map((slot) => ({
            startTime: slot.startTime,
            endTime: slot.endTime,
            isBooked: false,
            type: slot.type || 'clinic'
          })),
          breaks: [],
          isAvailable: true
        });
        updated = true;
      }
    } else if (dayAvailability) {
      calendar.days.push({
        date: targetDate,
        dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
        isHoliday: false,
        professionals: [
          {
            professionalId,
            professionalType,
            bookedSlots: dayAvailability.slots.map((slot) => ({
              startTime: slot.startTime,
              endTime: slot.endTime,
              isBooked: false,
              type: slot.type || 'clinic'
            })),
            breaks: [],
            isAvailable: true
          }
        ]
      });
      updated = true;
    }
  }

  if (updated) {
    calendar.days = calendar.days
      .filter((day) => day.professionals.length > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    await calendar.save();
  }
}
