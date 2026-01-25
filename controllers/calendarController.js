const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');

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
        calendar = await initializeCalendar(targetYear, targetMonth);
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
        calendar = await initializeCalendar(year, month);
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

// Update availability (current/future only)
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
    
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    const dayIndex = calendar.days.findIndex(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
    });
    
    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Day not found in calendar'
      });
    }
    
    // Check for existing appointments
    if (isAvailable === false) {
      const existingAppointments = await Appointment.find({
        [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physiotherapist' ? 'physioId' : 'pathologyId']: profileId,
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
    
    if (professionalIndex === -1) {
      calendar.days[dayIndex].professionals.push({
        professionalId: profileId,
        professionalType,
        bookedSlots: [],
        breaks: breaks || [],
        workingHours: workingHours || [],
        isAvailable: isAvailable !== undefined ? isAvailable : true
      });
    } else {
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

// Add break (current/future only)
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
    
    // Check for appointment conflicts
    const existingAppointments = await Appointment.find({
      [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physiotherapist' ? 'physioId' : 'pathologyId']: profileId,
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
      calendar = await initializeCalendar(year, month);
    }
    
    const dayIndex = calendar.days.findIndex(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
    });
    
    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Day not found in calendar'
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
      calendar.days[dayIndex].professionals.push({
        professionalId: profileId,
        professionalType,
        bookedSlots: [],
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

// Remove break
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

// Get available slots (current/future only)
exports.getAvailableSlots = async (req, res) => {
  try {
    const { professionalId, professionalType, date, duration = 30 } = req.query;
    
    if (!professionalId || !professionalType || !date) {
      return res.status(400).json({
        success: false,
        error: 'Professional ID, type, and date are required'
      });
    }
    
    const targetDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (targetDate < today) {
      return res.status(400).json({
        success: false,
        error: 'Cannot get available slots for past dates'
      });
    }
    
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    let professional;
    try {
      professional = await getProfessionalDetails(professionalId, professionalType);
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
    
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
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
    
    if (!professionalSchedule || !professionalSchedule.isAvailable) {
      return res.json({
        success: true,
        availableSlots: [],
        professional: {
          name: professional.name,
          type: professionalType
        }
      });
    }
    
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayAvailability = professional.availability?.find(a => a.day === dayName);
    
    if (!dayAvailability || !dayAvailability.slots || dayAvailability.slots.length === 0) {
      return res.json({
        success: true,
        availableSlots: [],
        professional: {
          name: professional.name,
          type: professionalType
        }
      });
    }
    
    // Get appointments for double-check (source of truth)
    const existingAppointments = await Appointment.find({
      [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physiotherapist' ? 'physioId' : 'pathologyId']: professionalId,
      appointmentDate: {
        $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
        $lt: new Date(targetDate.setHours(23, 59, 59, 999))
      },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    });
    
    const bookedSlots = professionalSchedule.bookedSlots || [];
    const allBookedSlots = [
      ...bookedSlots,
      ...existingAppointments.map(apt => ({
        startTime: apt.startTime,
        endTime: apt.endTime
      }))
    ];
    
    const breaks = professionalSchedule.breaks || [];
    const workingHours = professionalSchedule.workingHours || [];
    
    const availableSlots = [];
    
    for (const slot of dayAvailability.slots) {
      if (slot.isAvailable === false) continue;
      
      const slotStartMinutes = timeToMinutes(slot.startTime);
      const slotEndMinutes = timeToMinutes(slot.endTime);
      const slotDuration = slotEndMinutes - slotStartMinutes;
      
      if (parseInt(duration) > slotDuration) continue;
      
      if (workingHours.length > 0) {
        const isWithinWorkingHours = workingHours.some(wh => 
          timeToMinutes(slot.startTime) >= timeToMinutes(wh.startTime) && 
          timeToMinutes(slot.endTime) <= timeToMinutes(wh.endTime)
        );
        if (!isWithinWorkingHours) continue;
      }
      
      const isInBreak = breaks.some(br => {
        const breakStart = timeToMinutes(br.startTime);
        const breakEnd = timeToMinutes(br.endTime);
        return (slotStartMinutes < breakEnd && slotEndMinutes > breakStart);
      });
      
      if (isInBreak) continue;
      
      const isBooked = allBookedSlots.some(booked => {
        const bookedStart = timeToMinutes(booked.startTime);
        const bookedEnd = timeToMinutes(booked.endTime);
        return (slotStartMinutes < bookedEnd && slotEndMinutes > bookedStart);
      });
      
      if (!isBooked) {
        availableSlots.push({
          startTime: slot.startTime,
          endTime: slot.endTime,
          type: slot.type || 'clinic',
          fee: slot.type === 'home' ? professional.homeVisitFee : professional.consultationFee,
          duration: slotDuration,
          isAvailable: true
        });
      }
    }
    
    res.json({
      success: true,
      availableSlots: availableSlots.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime)),
      professional: {
        name: professional.name,
        type: professionalType,
        consultationFee: professional.consultationFee,
        homeVisitFee: professional.homeVisitFee
      },
      date: targetDate.toISOString().split('T')[0],
      dayName: day.dayName,
      slotDuration: parseInt(duration)
    });
  } catch (error) {
    console.error('Error fetching available slots:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available slots'
    });
  }
};

// Book slot (current/future only)
exports.bookSlot = async (req, res) => {
  try {
    const { 
      professionalId, 
      professionalType, 
      date, 
      startTime, 
      endTime,
      appointmentId,
      patientId 
    } = req.body;
    
    if (!professionalId || !professionalType || !date || !startTime || !endTime || !appointmentId || !patientId) {
      return res.status(400).json({
        success: false,
        error: 'All fields are required'
      });
    }
    
    if (!['patient', 'admin'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Only patients or admins can book slots'
      });
    }
    
    if (req.user.role === 'patient') {
      const patientProfile = await require('../models/PatientProfile').findOne({ userId: req.user.id });
      if (!patientProfile || patientProfile._id.toString() !== patientId) {
        return res.status(403).json({
          success: false,
          error: 'Not authorized to book slot for this patient'
        });
      }
    }
    
    const targetDate = new Date(date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (targetDate < today) {
      return res.status(400).json({
        success: false,
        error: 'Cannot book slots for past dates'
      });
    }
    
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid time format'
      });
    }
    
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      return res.status(400).json({
        success: false,
        error: 'End time must be after start time'
      });
    }
    
    // Check appointment collection directly (source of truth)
    const existingAppointments = await Appointment.find({
      [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physiotherapist' ? 'physioId' : 'pathologyId']: professionalId,
      appointmentDate: {
        $gte: new Date(targetDate.setHours(0, 0, 0, 0)),
        $lt: new Date(targetDate.setHours(23, 59, 59, 999))
      },
      $or: [
        { 
          startTime: { $lt: endTime },
          endTime: { $gt: startTime }
        }
      ],
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    });
    
    if (existingAppointments.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Selected slot is not available'
      });
    }
    
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    const dayIndex = calendar.days.findIndex(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === targetDate.toISOString().split('T')[0];
    });
    
    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        error: 'Day not found in calendar'
      });
    }
    
    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof => 
      prof.professionalId.toString() === professionalId && 
      prof.professionalType === professionalType
    );
    
    const bookedSlot = {
      appointmentId,
      patientId,
      startTime,
      endTime,
      bookedAt: new Date(),
      bookedBy: req.user.id,
      status: 'booked'
    };
    
    if (professionalIndex === -1) {
      calendar.days[dayIndex].professionals.push({
        professionalId,
        professionalType,
        bookedSlots: [bookedSlot],
        breaks: [],
        isAvailable: true
      });
    } else {
      calendar.days[dayIndex].professionals[professionalIndex].bookedSlots.push(bookedSlot);
    }
    
    await calendar.save();
    
    res.json({
      success: true,
      message: 'Slot booked successfully',
      bookedSlot,
      date: targetDate.toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Error booking slot:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
    
    const calendar = await initializeCalendar(year, month);
    
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

// Initialize calendar for current/future month
async function initializeCalendar(year, month) {
  try {
    if (month < 1 || month > 12) {
      throw new Error('Month must be between 1 and 12');
    }
    
    const today = new Date();
    const targetDate = new Date(year, month - 1, 1);
    
    // Don't initialize past months
    if (targetDate < today) {
      return null;
    }
    
    const doctors = await DoctorProfile.find({ 
      isActive: true, 
      verificationStatus: 'approved' 
    }).populate('userId', 'isVerified isActive');
    
    const physios = await PhysiotherapistProfile.find({ 
      isActive: true, 
      verificationStatus: 'approved' 
    }).populate('userId', 'isVerified isActive');
    
    const pathologists = await PathologyProfile.find({ 
      isActive: true, 
      verificationStatus: 'approved' 
    }).populate('userId', 'isVerified isActive');
    
    const daysInMonth = new Date(year, month, 0).getDate();
    const days = [];
    
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month - 1, day);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
      const dayNameLower = dayName.toLowerCase();
      
      const professionals = [];
      
      // Add doctors
      for (const doctor of doctors) {
        if (!doctor.userId?.isVerified || !doctor.userId?.isActive) continue;
        
        const dayAvailability = doctor.availability?.find(a => a.day === dayNameLower);
        if (dayAvailability && dayAvailability.slots?.length > 0) {
          professionals.push({
            professionalId: doctor._id,
            professionalType: 'doctor',
            bookedSlots: [],
            breaks: [],
            workingHours: [],
            isAvailable: true
          });
        }
      }
      
      // Add physiotherapists
      for (const physio of physios) {
        if (!physio.userId?.isVerified || !physio.userId?.isActive) continue;
        
        const dayAvailability = physio.availability?.find(a => a.day === dayNameLower);
        if (dayAvailability && dayAvailability.slots?.length > 0) {
          professionals.push({
            professionalId: physio._id,
            professionalType: 'physiotherapist',
            bookedSlots: [],
            breaks: [],
            workingHours: [],
            isAvailable: true
          });
        }
      }
      
      // Add pathologists
      for (const pathologist of pathologists) {
        if (!pathologist.userId?.isVerified || !pathologist.userId?.isActive) continue;
        
        const hasSlotsForDate = pathologist.testSlots?.some(slot => {
          const slotDate = new Date(slot.date);
          return slotDate.toISOString().split('T')[0] === date.toISOString().split('T')[0];
        });
        
        if (hasSlotsForDate) {
          professionals.push({
            professionalId: pathologist._id,
            professionalType: 'pathology',
            bookedSlots: [],
            breaks: [],
            workingHours: [],
            isAvailable: true
          });
        }
      }
      
      days.push({
        date,
        dayName,
        isHoliday: false,
        professionals
      });
    }
    
    const calendar = await Calendar.create({ year, month, days });
    console.log(`📅 Calendar initialized for ${month}/${year} with ${days.length} days`);
    
    return calendar;
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
      [professionalType === 'doctor' ? 'doctorId' : professionalType === 'physiotherapist' ? 'physioId' : 'pathologyId']: professionalId,
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
    'physio': 'physiotherapist',
    'pathology': 'pathology'
  };
  return roleMap[userRole] || userRole;
}

async function getProfessionalDetails(professionalId, professionalType) {
  let professional;
  
  if (professionalType === 'doctor') {
    professional = await DoctorProfile.findById(professionalId)
      .populate('userId', 'isVerified isActive');
  } else if (professionalType === 'physiotherapist') {
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