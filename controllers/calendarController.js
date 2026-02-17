const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const { updateDoctorInCalendar, initializeCalendarForMonth } = require('../jobs/calendarJob');

// ========== CALENDAR FUNCTIONS ==========

// Get calendar view - SMART: Past months generated on-demand, current/future months stored
exports.getCalendar = async (req, res) => {
  try {
    const { year, month, professionalId, professionalType } = req.query;

    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const targetDate = new Date(targetYear, targetMonth - 1, 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Validate month
    if (targetMonth < 1 || targetMonth > 12) {
      return res.status(400).json({
        success: false,
        error: 'Month must be between 1 and 12'
      });
    }

    // Determine calendar type
    const isPastMonth = targetDate.getFullYear() < today.getFullYear() ||
      (targetDate.getFullYear() === today.getFullYear() && targetMonth < today.getMonth() + 1);

    let calendar = null;

    if (isPastMonth) {
      // PAST MONTH: Generate on-demand from appointments (no storage)
      calendar = await generatePastCalendar(targetYear, targetMonth);
    } else {
      // CURRENT/FUTURE MONTH: Use stored calendar
      calendar = await Calendar.findOne({ year: targetYear, month: targetMonth });

      if (!calendar) {
        // Initialize if not exists (future month)
        calendar = await initializeCalendarForMonth(targetYear, targetMonth);
      }
    }

    if (!calendar) {
      return res.json({
        success: true,
        calendar: {
          year: targetYear,
          month: targetMonth,
          days: []
        },
        meta: {
          totalDays: 0,
          monthType: isPastMonth ? 'past' : 'future',
          isGeneratedOnDemand: isPastMonth
        }
      });
    }

    // Role-based filtering
    let filteredDays = calendar.days;

    if (professionalId && professionalType) {
      filteredDays = calendar.days.map(day => ({
        ...day.toObject(),
        professionals: day.professionals.filter(prof =>
          prof.professionalId.toString() === professionalId &&
          prof.professionalType === professionalType
        )
      }));
    } else if (['doctor', 'physio', 'pathology'].includes(req.user.role)) {
      const profileId = await getProfessionalProfileId(req.user);
      if (profileId) {
        const profType = mapUserRoleToProfessionalType(req.user.role);
        filteredDays = calendar.days.map(day => ({
          ...day.toObject(),
          professionals: day.professionals.filter(prof =>
            prof.professionalId.toString() === profileId.toString() &&
            prof.professionalType === profType
          )
        }));
      }
    }

    res.json({
      success: true,
      calendar: {
        year: calendar.year,
        month: calendar.month,
        days: filteredDays
      },
      meta: {
        totalDays: filteredDays.length,
        today: today.toISOString().split('T')[0],
        userRole: req.user.role,
        monthType: isPastMonth ? 'past' : 'future',
        isGeneratedOnDemand: isPastMonth
      }
    });
  } catch (error) {
    console.error('Error fetching calendar:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calendar'
    });
  }
};

// Get professional schedule
exports.getProfessionalSchedule = async (req, res) => {
  try {
    const { professionalId, professionalType, date, weekView = false } = req.query;

    if (!professionalId || !professionalType) {
      return res.status(400).json({
        success: false,
        error: 'Professional ID and type are required'
      });
    }

    const targetDate = date ? new Date(date) : new Date();
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isPastDate = targetDate < today;
    let calendar;

    if (isPastDate) {
      // Generate past schedule from appointments
      calendar = await generatePastCalendarForProfessional(professionalId, professionalType, targetDate);
    } else {
      // Use stored calendar
      calendar = await Calendar.findOne({ year, month });
      if (!calendar) {
        calendar = await initializeCalendarForMonth(year, month);
      }
    }

    if (!calendar) {
      return res.status(404).json({
        success: false,
        error: 'Calendar not found'
      });
    }

    let professional;
    try {
      professional = await getProfessionalDetails(professionalId, professionalType);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }

    if (weekView) {
      const weekSchedule = await getWeekSchedule(calendar, professionalId, professionalType, targetDate);
      res.json({
        success: true,
        schedule: weekSchedule,
        professional: {
          name: professional.name,
          type: professionalType,
          consultationFee: professional.consultationFee,
          homeVisitFee: professional.homeVisitFee,
          availability: professional.availability
        },
        viewType: 'week'
      });
    } else {
      const day = calendar.days.find(d => {
        const dDate = new Date(d.date);
        return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
      });

      if (!day) {
        return res.status(404).json({
          success: false,
          error: 'Day not found'
        });
      }

      const professionalSchedule = day.professionals.find(prof =>
        prof.professionalId.toString() === professionalId &&
        prof.professionalType === professionalType
      );

      res.json({
        success: true,
        schedule: professionalSchedule || {
          bookedSlots: [],
          breaks: [],
          isAvailable: true
        },
        date: targetDate,
        dayName: day.dayName,
        professional: {
          name: professional.name,
          type: professionalType,
          consultationFee: professional.consultationFee,
          homeVisitFee: professional.homeVisitFee
        },
        isPastDate
      });
    }
  } catch (error) {
    console.error('Error fetching professional schedule:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch schedule'
    });
  }
};

// Update availability (current/future only) - IMPROVED VERSION
exports.updateAvailability = async (req, res) => {
  try {
    const { date, isAvailable, breaks, workingHours } = req.body;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'Date is required'
      });
    }

    if (!['doctor', 'physio', 'pathology'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Only professionals can update availability'
      });
    }

    const profileId = await getProfessionalProfileId(req.user);
    if (!profileId) {
      return res.status(404).json({
        success: false,
        error: 'Professional profile not found'
      });
    }

    const professionalType = mapUserRoleToProfessionalType(req.user.role);
    const targetDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (targetDate < today) {
      return res.status(400).json({
        success: false,
        error: 'Cannot update availability for past dates'
      });
    }

    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;

    // Get professional profile to sync with calendar
    let professional;
    try {
      professional = await getProfessionalDetails(profileId, professionalType);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }

    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendarForMonth(year, month);
    }

    const dayIndex = calendar.days.findIndex(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
    });

    if (dayIndex === -1 && isAvailable !== false) {
      // Create new day if it doesn't exist and doctor wants to be available
      const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
      calendar.days.push({
        date: targetDate,
        dayName,
        isHoliday: false,
        professionals: []
      });
      calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
      dayIndex = calendar.days.findIndex(d => {
        const dDate = new Date(d.date);
        return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
      });
    }

    if (dayIndex === -1 && isAvailable === false) {
      // If marking as unavailable and day doesn't exist, nothing to do
      return res.json({
        success: true,
        message: 'Availability updated successfully',
        date: targetDate.toISOString().split('T')[0]
      });
    }

    // Check for existing appointments
    if (isAvailable === false) {
      const existingAppointments = await Appointment.find({
        [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physio' ? 'physioId' : 'pathologyId']: profileId,
        appointmentDate: {
          $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
          $lt: new Date(targetDate.setHours(23, 59, 59, 999))
        },
        status: { $in: ['pending', 'confirmed', 'accepted'] }
      });

      if (existingAppointments.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Cannot mark as unavailable when there are existing appointments',
          existingAppointments: existingAppointments.length
        });
      }
    }

    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof =>
      prof.professionalId.toString() === profileId.toString() &&
      prof.professionalType === professionalType
    );

    if (professionalIndex === -1 && isAvailable !== false) {
      // Add professional to this day
      const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const dayAvailability = professional.availability?.find(a => a.day === dayName);
      const derivedWorkingHours =
        (dayAvailability?.slots || []).map(s => ({
          startTime: s.startTime,
          endTime: s.endTime
        }));

      calendar.days[dayIndex].professionals.push({
        professionalId: profileId,
        professionalType,
        bookedSlots: [],                 // IMPORTANT: no fake “bookings”
        breaks: breaks || [],
        workingHours: workingHours?.length ? workingHours : derivedWorkingHours,
        isAvailable: isAvailable !== undefined ? isAvailable : true
      });

    } else if (professionalIndex !== -1) {
      if (isAvailable !== undefined) {
        calendar.days[dayIndex].professionals[professionalIndex].isAvailable = isAvailable;
      }
      if (breaks) {
        calendar.days[dayIndex].professionals[professionalIndex].breaks = breaks;
      }
      if (workingHours) {
        calendar.days[dayIndex].professionals[professionalIndex].workingHours = workingHours;
      }
    }

    await calendar.save();

    // Trigger immediate calendar sync for this professional
    setTimeout(async () => {
      try {
        console.log(`🔄 Triggering calendar sync for ${professional.name}`);
        await updateDoctorInCalendar(profileId, professional);
        console.log(`✅ Calendar synced for ${professional.name}`);
      } catch (syncError) {
        console.error('❌ Error syncing calendar:', syncError);
      }
    }, 1000);

    res.json({
      success: true,
      message: 'Availability updated successfully',
      date: targetDate.toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Error updating availability:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Add break (current/future only) - IMPROVED VERSION
exports.addBreak = async (req, res) => {
  try {
    const { date, startTime, endTime, reason } = req.body;

    if (!date || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'Date, start time, and end time are required'
      });
    }

    if (!['doctor', 'physio', 'pathology'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Only professionals can add breaks'
      });
    }

    const profileId = await getProfessionalProfileId(req.user);
    if (!profileId) {
      return res.status(404).json({
        success: false,
        error: 'Professional profile not found'
      });
    }

    const professionalType = mapUserRoleToProfessionalType(req.user.role);
    const targetDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (targetDate < today) {
      return res.status(400).json({
        success: false,
        error: 'Cannot add breaks for past dates'
      });
    }

    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;

    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid time format. Use HH:MM (24-hour format)'
      });
    }

    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      return res.status(400).json({
        success: false,
        error: 'End time must be after start time'
      });
    }

    // Get professional profile to sync with calendar
    let professional;
    try {
      professional = await getProfessionalDetails(profileId, professionalType);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }

    // Check for appointment conflicts
    const existingAppointments = await Appointment.find({
      [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physio' ? 'physioId' : 'pathologyId']: profileId,
      appointmentDate: {
        $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
        $lt: new Date(targetDate.setHours(23, 59, 59, 999))
      },
      startTime: { $lte: endTime },
      endTime: { $gte: startTime },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    });

    if (existingAppointments.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Break conflicts with existing appointments',
        conflictingAppointments: existingAppointments.length
      });
    }

    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendarForMonth(year, month);
    }

    const dayIndex = calendar.days.findIndex(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
    });

    if (dayIndex === -1) {
      // Create day if it doesn't exist
      const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
      calendar.days.push({
        date: targetDate,
        dayName,
        isHoliday: false,
        professionals: []
      });
      calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
      dayIndex = calendar.days.findIndex(d => {
        const dDate = new Date(d.date);
        return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
      });
    }

    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof =>
      prof.professionalId.toString() === profileId.toString() &&
      prof.professionalType === professionalType
    );

    const newBreak = {
      startTime,
      endTime,
      reason: reason || 'Break',
      addedAt: new Date(),
      addedBy: req.user.id
    };

    if (professionalIndex === -1) {
      // Add professional with break
      const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      const dayAvailability = professional.availability?.find(a => a.day === dayName);

      const bookedSlots = dayAvailability?.slots?.map(slot => ({
        startTime: slot.startTime,
        endTime: slot.endTime,
        isBooked: false,
        type: slot.type || 'clinic',
        maxPatients: slot.maxPatients || 1
      })) || [];

      calendar.days[dayIndex].professionals.push({
        professionalId: profileId,
        professionalType,
        bookedSlots: bookedSlots,
        breaks: [newBreak],
        isAvailable: true
      });
    } else {
      const existingBreaks = calendar.days[dayIndex].professionals[professionalIndex].breaks || [];
      const hasOverlap = existingBreaks.some(br =>
        timeToMinutes(startTime) < timeToMinutes(br.endTime) &&
        timeToMinutes(endTime) > timeToMinutes(br.startTime)
      );

      if (hasOverlap) {
        return res.status(400).json({
          success: false,
          error: 'Break overlaps with existing break'
        });
      }

      calendar.days[dayIndex].professionals[professionalIndex].breaks.push(newBreak);
    }

    await calendar.save();

    // Trigger immediate calendar sync
    setTimeout(async () => {
      try {
        console.log(`🔄 Triggering calendar sync after adding break for ${professional.name}`);
        await updateDoctorInCalendar(profileId, professional);
        console.log(`✅ Calendar synced for ${professional.name}`);
      } catch (syncError) {
        console.error('❌ Error syncing calendar after break:', syncError);
      }
    }, 1000);

    res.json({
      success: true,
      message: 'Break added successfully',
      break: newBreak
    });
  } catch (error) {
    console.error('Error adding break:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Remove break - IMPROVED VERSION
exports.removeBreak = async (req, res) => {
  try {
    const { id: breakId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'Date is required'
      });
    }

    if (!['doctor', 'physio', 'pathology'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Only professionals can remove breaks'
      });
    }

    const profileId = await getProfessionalProfileId(req.user);
    if (!profileId) {
      return res.status(404).json({
        success: false,
        error: 'Professional profile not found'
      });
    }

    const professionalType = mapUserRoleToProfessionalType(req.user.role);
    const targetDate = new Date(date);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;

    // Get professional profile to sync with calendar
    let professional;
    try {
      professional = await getProfessionalDetails(profileId, professionalType);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }

    const calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      return res.status(404).json({
        success: false,
        error: 'Calendar not found'
      });
    }

    const dayIndex = calendar.days.findIndex(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
    });

    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Day not found'
      });
    }

    const professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof =>
      prof.professionalId.toString() === profileId.toString() &&
      prof.professionalType === professionalType
    );

    if (professionalIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found in calendar'
      });
    }

    const breaks = calendar.days[dayIndex].professionals[professionalIndex].breaks;
    const breakIndex = breaks.findIndex(br => br._id.toString() === breakId);

    if (breakIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Break not found'
      });
    }

    calendar.days[dayIndex].professionals[professionalIndex].breaks.splice(breakIndex, 1);
    await calendar.save();

    // Trigger immediate calendar sync
    setTimeout(async () => {
      try {
        console.log(`🔄 Triggering calendar sync after removing break for ${professional.name}`);
        await updateDoctorInCalendar(profileId, professional);
        console.log(`✅ Calendar synced for ${professional.name}`);
      } catch (syncError) {
        console.error('❌ Error syncing calendar after break removal:', syncError);
      }
    }, 1000);

    res.json({
      success: true,
      message: 'Break removed successfully'
    });
  } catch (error) {
    console.error('Error removing break:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Get available slots (current/future only) - FIXED VERSION
exports.getAvailableSlots = async (req, res) => {
  try {
    const { professionalId, professionalType, date, duration = 30, type = 'clinic' } = req.query;

    if (!professionalId || !professionalType || !date) {
      return res.status(400).json({
        success: false,
        error: 'Professional ID, type, and date are required'
      });
    }

    const slotSize = parseInt(duration, 10);
    if (!slotSize || slotSize <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid duration' });
    }

    // ---- Local (IST/server-local) date boundaries, no ISO string comparisons ----
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date format' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const targetDayStart = new Date(targetDate);
    targetDayStart.setHours(0, 0, 0, 0);

    const targetDayEnd = new Date(targetDate);
    targetDayEnd.setHours(23, 59, 59, 999);

    if (targetDayStart < today) {
      return res.status(400).json({
        success: false,
        error: 'Cannot get available slots for past dates'
      });
    }

    const year = targetDayStart.getFullYear();
    const month = targetDayStart.getMonth() + 1;

    // Local date key helper (fixes UTC/IST mismatch)
    const dateKeyLocal = (d) => {
      const x = new Date(d);
      const y = x.getFullYear();
      const m = String(x.getMonth() + 1).padStart(2, '0');
      const dd = String(x.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };

    let professional;
    try {
      professional = await getProfessionalDetails(professionalId, professionalType);
      console.log('📋 Professional details:', {
        name: professional.name,
        isVerified: professional.userId?.isVerified,
        isActive: professional.userId?.isActive,
        verificationStatus: professional.verificationStatus,
        availability: professional.availability?.length
      });
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'Professional not found'
      });
    }

    if (!professional.userId?.isVerified || !professional.userId?.isActive) {
      return res.status(400).json({
        success: false,
        error: 'Professional is not available for appointments'
      });
    }

    if (professional.verificationStatus !== 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Professional profile is not approved'
      });
    }

    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendarForMonth(year, month);
    }

    if (!calendar || !Array.isArray(calendar.days)) {
      return res.json({
        success: true,
        availableSlots: [],
        professional: { name: professional.name, type: professionalType }
      });
    }

    const targetKey = dateKeyLocal(targetDayStart);

    const day = calendar.days.find(d => dateKeyLocal(d.date) === targetKey);

    if (!day) {
      console.log(`📅 No calendar day found for ${targetKey}`);
      return res.json({
        success: true,
        availableSlots: [],
        professional: { name: professional.name, type: professionalType }
      });
    }

    const professionalSchedule = (day.professionals || []).find(prof =>
      String(prof.professionalId) === String(professionalId) &&
      prof.professionalType === professionalType
    );

    if (!professionalSchedule || !professionalSchedule.isAvailable) {
      console.log(`📅 Professional not available or not found in calendar for ${targetKey}`);
      return res.json({
        success: true,
        availableSlots: [],
        professional: { name: professional.name, type: professionalType }
      });
    }

    // SOURCE OF AVAILABILITY NOW: CALENDAR workingHours (already synced from profile)
    const workingHours = professionalSchedule.workingHours || [];
    const breaks = professionalSchedule.breaks || [];
    const bookedSlots = professionalSchedule.bookedSlots || [];

    // If calendar has no working hours, return empty
    if (!workingHours.length) {
      console.log(`📅 Calendar has no workingHours for ${professional.name} on ${targetKey}`);
      return res.json({
        success: true,
        availableSlots: [],
        professional: { name: professional.name, type: professionalType }
      });
    }

    // Fetch real appointments (truth)
    const idField =
      professionalType === 'doctor' ? 'doctorId' :
      professionalType === 'physio' ? 'physiotherapistId' :
      'pathologyId';

    const existingAppointments = await Appointment.find({
      [idField]: professionalId,
      appointmentDate: { $gte: targetDayStart, $lte: targetDayEnd },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    }).select('startTime endTime status');

    console.log(`📅 Found ${existingAppointments.length} existing appointments for ${targetKey}`);
    console.log(`📅 Calendar has ${bookedSlots.length} bookedSlots`);

    // Helper: overlap check by minutes
    const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

    // Build slot list from workingHours ranges
    const availableSlots = [];

    for (const wh of workingHours) {
      const whStart = timeToMinutes(wh.startTime);
      const whEnd = timeToMinutes(wh.endTime);

      if (whEnd <= whStart) continue;

      // generate slots: [t, t+slotSize)
      for (let t = whStart; t + slotSize <= whEnd; t += slotSize) {
        const sStart = t;
        const sEnd = t + slotSize;

        // Break check
        const inBreak = breaks.some(br => overlaps(sStart, sEnd, timeToMinutes(br.startTime), timeToMinutes(br.endTime)));
        if (inBreak) continue;

        // Calendar bookedSlots check (if any)
        const bookedInCalendar = bookedSlots.some(b => {
          if ((b.status || 'booked') === 'cancelled') return false;
          return overlaps(sStart, sEnd, timeToMinutes(b.startTime), timeToMinutes(b.endTime));
        });

        // Appointment truth check
        const bookedInAppointments = existingAppointments.some(a =>
          overlaps(sStart, sEnd, timeToMinutes(a.startTime), timeToMinutes(a.endTime))
        );

        if (bookedInCalendar || bookedInAppointments) continue;

        // Convert back to HH:MM
        const toHHMM = (mins) => {
          const hh = String(Math.floor(mins / 60)).padStart(2, '0');
          const mm = String(mins % 60).padStart(2, '0');
          return `${hh}:${mm}`;
        };

        const slotType = type || 'clinic';
        const fee = slotType === 'home' ? professional.homeVisitFee : professional.consultationFee;

        availableSlots.push({
          startTime: toHHMM(sStart),
          endTime: toHHMM(sEnd),
          type: slotType,
          fee,
          duration: slotSize,
          isAvailable: true
        });
      }
    }

    console.log(`📅 Found ${availableSlots.length} available slots for ${professional.name} on ${targetKey}`);

    return res.json({
      success: true,
      availableSlots: availableSlots.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)),
      professional: {
        name: professional.name,
        type: professionalType,
        consultationFee: professional.consultationFee,
        homeVisitFee: professional.homeVisitFee
      },
      date: targetKey,
      dayName: day.dayName,
      slotDuration: slotSize
    });
  } catch (error) {
    console.error('Error fetching available slots:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch available slots'
    });
  }
};


exports.bookSlot = async (req, res) => {
  try {
    const {
      professionalId,
      professionalType, // 'doctor' | 'physio' | 'pathology'
      date,            // 'YYYY-MM-DD' or ISO
      startTime,       // 'HH:mm'
      endTime,         // 'HH:mm'
      appointmentId,
      patientId
    } = req.body;

    if (
      !professionalId || !professionalType || !date ||
      !startTime || !endTime || !appointmentId || !patientId
    ) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }

    if (!['patient', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Only patients or admins can book slots' });
    }

    // Patients can only book for themselves
    if (req.user.role === 'patient') {
      const PatientProfile = require('../models/PatientProfile');
      const patientProfile = await PatientProfile.findOne({ userId: req.user.id });
      if (!patientProfile || patientProfile._id.toString() !== patientId.toString()) {
        return res.status(403).json({ success: false, error: 'Not authorized to book slot for this patient' });
      }
    }

    // Date validation (avoid mutation bugs)
    const targetDate = new Date(date);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const targetDayStart = new Date(targetDate);
    targetDayStart.setHours(0, 0, 0, 0);

    const targetDayEnd = new Date(targetDate);
    targetDayEnd.setHours(23, 59, 59, 999);

    if (targetDayStart < today) {
      return res.status(400).json({ success: false, error: 'Cannot book slots for past dates' });
    }

    const year = targetDayStart.getFullYear();
    const month = targetDayStart.getMonth() + 1;

    // time validation helpers must exist in your file:
    // isValidTime('HH:mm'), timeToMinutes('HH:mm')
    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({ success: false, error: 'Invalid time format' });
    }
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      return res.status(400).json({ success: false, error: 'End time must be after start time' });
    }

    // Get professional (for availability -> workingHours, and for name in logs)
    let professional;
    try {
      professional = await getProfessionalDetails(professionalId, professionalType);
    } catch (e) {
      return res.status(404).json({ success: false, error: 'Professional not found' });
    }

    // Appointment collection is the source of truth for conflicts
    const profKey =
      professionalType === 'doctor'
        ? 'doctorId'
        : professionalType === 'physio'
          ? 'physioId'
          : 'pathologyId';

    const existingAppointments = await Appointment.find({
      [profKey]: professionalId,
      appointmentDate: { $gte: targetDayStart, $lt: targetDayEnd },
      // overlap
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    }).select('_id');

    if (existingAppointments.length > 0) {
      return res.status(400).json({ success: false, error: 'Selected slot is not available' });
    }

    // Get or create calendar
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendarForMonth(year, month);
    }

    // Find or create the day entry (compare by YYYY-MM-DD)
    const dateStr = targetDayStart.toISOString().split('T')[0];

    let dayIndex = calendar.days.findIndex(d => {
      const dStr = new Date(d.date).toISOString().split('T')[0];
      return dStr === dateStr;
    });

    if (dayIndex === -1) {
      const dayName = targetDayStart.toLocaleDateString('en-US', { weekday: 'long' });
      calendar.days.push({
        date: targetDayStart,
        dayName,
        isHoliday: false,
        professionals: []
      });

      calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));

      dayIndex = calendar.days.findIndex(d => {
        const dStr = new Date(d.date).toISOString().split('T')[0];
        return dStr === dateStr;
      });
    }

    // Find professional entry within the day
    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(p =>
      p.professionalId.toString() === professionalId.toString() &&
      p.professionalType === professionalType
    );

    // A REAL booked slot entry (bookedSlots = ONLY real appointments)
    const bookedSlot = {
      appointmentId,
      patientId,
      startTime,
      endTime,
      bookedAt: new Date(),
      bookedBy: req.user.id,
      status: 'booked'
    };

    // Derive workingHours from weekly availability template (optional)
    const dayNameLower = targetDayStart
      .toLocaleDateString('en-US', { weekday: 'long' })
      .toLowerCase();

    const dayAvailability = professional?.availability?.find(a => a.day === dayNameLower);
    const derivedWorkingHours =
      (dayAvailability?.slots || []).map(s => ({ startTime: s.startTime, endTime: s.endTime }));

    if (professionalIndex === -1) {
      // Create professional entry with ONLY this booking in bookedSlots
      calendar.days[dayIndex].professionals.push({
        professionalId,
        professionalType,
        bookedSlots: [bookedSlot],
        breaks: [],
        workingHours: derivedWorkingHours, // availability lives here
        isAvailable: true
      });
    } else {
      const profRef = calendar.days[dayIndex].professionals[professionalIndex];

      // ensure arrays
      profRef.bookedSlots = profRef.bookedSlots || [];
      profRef.breaks = profRef.breaks || [];
      profRef.workingHours = profRef.workingHours || derivedWorkingHours;

      // Prevent duplicates
      const already = profRef.bookedSlots.find(s =>
        (s.appointmentId && s.appointmentId.toString() === appointmentId.toString()) ||
        (s.startTime === startTime && s.endTime === endTime && s.status !== 'cancelled')
      );

      if (already) {
        // If same appointment, refresh fields; if overlap, conflict should have been caught by Appointment query.
        already.appointmentId = appointmentId;
        already.patientId = patientId;
        already.startTime = startTime;
        already.endTime = endTime;
        already.bookedAt = new Date();
        already.bookedBy = req.user.id;
        already.status = 'booked';
      } else {
        profRef.bookedSlots.push(bookedSlot);
      }

      // Optionally keep workingHours synced (do not touch bookedSlots for availability)
      if (!profRef.workingHours || profRef.workingHours.length === 0) {
        profRef.workingHours = derivedWorkingHours;
      }
    }

    calendar.markModified('days');
    await calendar.save();

    // Trigger calendar sync (safe now because updateDoctorInCalendar won't write availability into bookedSlots)
    setTimeout(async () => {
      try {
        console.log(`🔄 Triggering calendar sync after booking slot for ${professional?.name || professionalId}`);
        await updateDoctorInCalendar(professionalId, professional);
        console.log(`✅ Calendar synced after booking`);
      } catch (syncError) {
        console.error('❌ Error syncing calendar after booking:', syncError);
      }
    }, 1000);

    return res.json({
      success: true,
      message: 'Slot booked successfully',
      bookedSlot,
      date: dateStr
    });
  } catch (error) {
    console.error('Error booking slot:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
};


// Admin: Initialize calendar for month
exports.initializeCalendarForMonth = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { year, month } = req.body;

    if (!year || !month) {
      return res.status(400).json({
        success: false,
        error: 'Year and month are required'
      });
    }

    const calendar = await initializeCalendarForMonth(year, month);

    res.json({
      success: true,
      message: `Calendar initialized for ${month}/${year}`,
      calendar: {
        year: calendar.year,
        month: calendar.month,
        totalDays: calendar.days.length
      }
    });
  } catch (error) {
    console.error('Error initializing calendar:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// Admin: Clean old calendars
exports.cleanOldCalendars = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { monthsToKeep = 3 } = req.body;

    const today = new Date();
    const cutoffDate = new Date(today);
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsToKeep);

    const result = await Calendar.deleteMany({
      $or: [
        { year: { $lt: cutoffDate.getFullYear() } },
        {
          year: cutoffDate.getFullYear(),
          month: { $lt: cutoffDate.getMonth() + 1 }
        }
      ]
    });

    res.json({
      success: true,
      message: `Cleaned ${result.deletedCount} old calendars`,
      deletedCount: result.deletedCount,
      cutoffDate: cutoffDate.toISOString().split('T')[0],
      monthsKept: monthsToKeep
    });
  } catch (error) {
    console.error('Error cleaning old calendars:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// ========== HELPER FUNCTIONS ==========

// Initialize calendar for current/future month (now uses imported function)
async function initializeCalendar(year, month) {
  try {
    return await initializeCalendarForMonth(year, month);
  } catch (error) {
    console.error('Error initializing calendar:', error.message);
    throw error;
  }
}

// Generate past calendar from appointments
async function generatePastCalendar(year, month) {
  try {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    endDate.setHours(23, 59, 59, 999);

    const appointments = await Appointment.find({
      appointmentDate: {
        $gte: startDate,
        $lte: endDate
      },
      status: { $in: ['completed', 'cancelled', 'confirmed'] }
    })
      .populate('patientId', 'name')
      .populate('doctorId physioId pathologyId', 'name');

    const daysInMonth = new Date(year, month, 0).getDate();
    const days = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month - 1, day);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
      const dateStr = date.toISOString().split('T')[0];

      const dayAppointments = appointments.filter(apt => {
        const aptDate = new Date(apt.appointmentDate);
        return aptDate.toISOString().split('T')[0] === dateStr;
      });

      const professionalsMap = new Map();

      dayAppointments.forEach(apt => {
        const professionalType = apt.professionalType;
        const professionalId = apt[`${professionalType}Id`];

        if (!professionalId) return;

        const key = `${professionalType}-${professionalId}`;

        if (!professionalsMap.has(key)) {
          professionalsMap.set(key, {
            professionalId,
            professionalType,
            bookedSlots: []
          });
        }

        professionalsMap.get(key).bookedSlots.push({
          appointmentId: apt._id,
          patientId: apt.patientId?._id,
          patientName: apt.patientId?.name,
          startTime: apt.startTime,
          endTime: apt.endTime,
          status: apt.status,
          bookedAt: apt.createdAt
        });
      });

      const professionals = Array.from(professionalsMap.values());

      days.push({
        date,
        dayName,
        isHoliday: false,
        professionals
      });
    }

    return {
      year,
      month,
      days,
      isGenerated: true,
      totalAppointments: appointments.length
    };
  } catch (error) {
    console.error('Error generating past calendar:', error);
    return { year, month, days: [], isGenerated: true, totalAppointments: 0 };
  }
}

// Generate past calendar for specific professional
async function generatePastCalendarForProfessional(professionalId, professionalType, targetDate) {
  try {
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;

    const appointments = await Appointment.find({
      [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physio' ? 'physioId' : 'pathologyId']: professionalId,
      appointmentDate: {
        $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
        $lt: new Date(targetDate.setHours(23, 59, 59, 999))
      }
    }).populate('patientId', 'name');

    const day = {
      date: targetDate,
      dayName: targetDate.toLocaleDateString('en-US', { weekday: 'long' }),
      isHoliday: false,
      professionals: [{
        professionalId,
        professionalType,
        bookedSlots: appointments.map(apt => ({
          appointmentId: apt._id,
          patientId: apt.patientId?._id,
          patientName: apt.patientId?.name,
          startTime: apt.startTime,
          endTime: apt.endTime,
          status: apt.status,
          bookedAt: apt.createdAt
        })),
        breaks: [],
        isAvailable: true
      }]
    };

    return {
      year,
      month,
      days: [day],
      isGenerated: true,
      totalAppointments: appointments.length
    };
  } catch (error) {
    console.error('Error generating professional past calendar:', error);
    return { year, month: targetDate.getMonth() + 1, days: [], isGenerated: true, totalAppointments: 0 };
  }
}

async function getProfessionalProfileId(user) {
  try {
    let profile = null;

    if (user.role === 'doctor') {
      profile = await DoctorProfile.findOne({ userId: user.id });
    } else if (user.role === 'physio') {
      profile = await PhysiotherapistProfile.findOne({ userId: user.id });
    } else if (user.role === 'pathology') {
      profile = await PathologyProfile.findOne({ userId: user.id });
    }

    return profile ? profile._id : null;
  } catch (error) {
    console.error('Error getting professional profile ID:', error);
    return null;
  }
}

function mapUserRoleToProfessionalType(userRole) {
  const roleMap = {
    'doctor': 'doctor',
    'physio': 'physio',
    'pathology': 'pathology'
  };
  return roleMap[userRole] || userRole;
}

async function getProfessionalDetails(professionalId, professionalType) {
  let professional;

  if (professionalType === 'doctor') {
    professional = await DoctorProfile.findById(professionalId)
      .populate('userId', 'isVerified isActive');
  } else if (professionalType === 'physio') {
    professional = await PhysiotherapistProfile.findById(professionalId)
      .populate('userId', 'isVerified isActive');
  } else if (professionalType === 'pathology') {
    professional = await PathologyProfile.findById(professionalId)
      .populate('userId', 'isVerified isActive');
  } else {
    throw new Error('Invalid professional type');
  }

  if (!professional) {
    throw new Error('Professional not found');
  }

  return professional;
}

async function getWeekSchedule(calendar, professionalId, professionalType, targetDate) {
  const weekStart = getWeekStartDate(targetDate);
  const weekEnd = getWeekEndDate(targetDate);

  const weekDays = calendar.days.filter(day => {
    const dayDate = new Date(day.date);
    return dayDate >= weekStart && dayDate <= weekEnd;
  });

  const weekSchedule = {};

  for (const day of weekDays) {
    const professionalSchedule = day.professionals.find(prof =>
      prof.professionalId.toString() === professionalId &&
      prof.professionalType === professionalType
    );

    if (professionalSchedule) {
      weekSchedule[day.date.toISOString().split('T')[0]] = {
        ...professionalSchedule.toObject(),
        dayName: day.dayName,
        isHoliday: day.isHoliday
      };
    }
  }

  return weekSchedule;
}

function getWeekStartDate(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day;
  const weekStart = new Date(d.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);
  return weekStart;
}

function getWeekEndDate(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() + (6 - day);
  const weekEnd = new Date(d.setDate(diff));
  weekEnd.setHours(23, 59, 59, 999);
  return weekEnd;
}

function timeToMinutes(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

function isValidTime(timeStr) {
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  return timeRegex.test(timeStr);
}

// Export helper functions for use in other modules
module.exports.initializeCalendar = initializeCalendar;
module.exports.updateDoctorInCalendar = updateDoctorInCalendar;
module.exports.getProfessionalDetails = getProfessionalDetails;