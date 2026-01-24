const Calendar = require('../models/Calendar');
const Appointment = require('../models/Appointment');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');

exports.getCalendar = async (req, res) => {
  try {
    const { year, month, professionalId, professionalType } = req.query;
    
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    
    let calendar = await Calendar.findOne({ year: targetYear, month: targetMonth });
    
    if (!calendar) {
      calendar = await initializeCalendar(targetYear, targetMonth);
    }
    
    // Filter by professional if specified
    if (professionalId && professionalType) {
      calendar.days = calendar.days.map(day => ({
        ...day.toObject(),
        professionals: day.professionals.filter(prof => 
          prof.professionalId.toString() === professionalId && 
          prof.professionalType === professionalType
        )
      }));
    }
    
    res.json({ success: true, calendar });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getProfessionalSchedule = async (req, res) => {
  try {
    const { professionalId, professionalType, date } = req.query;
    
    if (!professionalId || !professionalType) {
      return res.status(400).json({ message: 'Professional ID and type are required' });
    }
    
    const targetDate = date ? new Date(date) : new Date();
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    let calendar = await Calendar.findOne({ year, month });
    
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    // Find the specific day
    const day = calendar.days.find(d => 
      d.date.toDateString() === targetDate.toDateString()
    );
    
    if (!day) {
      return res.status(404).json({ message: 'Day not found in calendar' });
    }
    
    // Find the professional in this day
    const professionalSchedule = day.professionals.find(prof => 
      prof.professionalId.toString() === professionalId && 
      prof.professionalType === professionalType
    );
    
    res.json({ 
      success: true, 
      schedule: professionalSchedule || { bookedSlots: [], breaks: [], isAvailable: true },
      date: targetDate,
      dayName: day.dayName
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateAvailability = async (req, res) => {
  try {
    const { date, isAvailable, breaks } = req.body;
    
    const targetDate = new Date(date);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    let calendar = await Calendar.findOne({ year, month });
    
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    // Find the day
    const dayIndex = calendar.days.findIndex(d => 
      d.date.toDateString() === targetDate.toDateString()
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ message: 'Day not found in calendar' });
    }
    
    // Find or create professional entry
    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof => 
      prof.professionalId.toString() === req.user.profileId && 
      prof.professionalType === req.user.role
    );
    
    if (professionalIndex === -1) {
      calendar.days[dayIndex].professionals.push({
        professionalId: req.user.profileId,
        professionalType: req.user.role,
        bookedSlots: [],
        breaks: breaks || [],
        isAvailable: isAvailable !== undefined ? isAvailable : true
      });
    } else {
      if (isAvailable !== undefined) {
        calendar.days[dayIndex].professionals[professionalIndex].isAvailable = isAvailable;
      }
      if (breaks) {
        calendar.days[dayIndex].professionals[professionalIndex].breaks = breaks;
      }
    }
    
    await calendar.save();
    
    res.json({ success: true, calendar: calendar.days[dayIndex] });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addBreak = async (req, res) => {
  try {
    const { date, startTime, endTime, reason } = req.body;
    
    const targetDate = new Date(date);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    let calendar = await Calendar.findOne({ year, month });
    
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    const dayIndex = calendar.days.findIndex(d => 
      d.date.toDateString() === targetDate.toDateString()
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ message: 'Day not found in calendar' });
    }
    
    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof => 
      prof.professionalId.toString() === req.user.profileId && 
      prof.professionalType === req.user.role
    );
    
    if (professionalIndex === -1) {
      calendar.days[dayIndex].professionals.push({
        professionalId: req.user.profileId,
        professionalType: req.user.role,
        bookedSlots: [],
        breaks: [{ startTime, endTime, reason }],
        isAvailable: true
      });
    } else {
      calendar.days[dayIndex].professionals[professionalIndex].breaks.push({
        startTime, endTime, reason
      });
    }
    
    await calendar.save();
    
    res.json({ success: true, message: 'Break added successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getAvailableSlots = async (req, res) => {
  try {
    const { professionalId, professionalType, date } = req.query;
    
    if (!professionalId || !professionalType || !date) {
      return res.status(400).json({ message: 'Professional ID, type, and date are required' });
    }
    
    const targetDate = new Date(date);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    // Get professional's availability
    let professional;
    if (professionalType === 'doctor') {
      professional = await DoctorProfile.findById(professionalId);
    } else {
      professional = await PhysiotherapistProfile.findById(professionalId);
    }
    
    if (!professional) {
      return res.status(404).json({ message: 'Professional not found' });
    }
    
    // Get calendar for the day
    let calendar = await Calendar.findOne({ year, month });
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    const day = calendar.days.find(d => 
      d.date.toDateString() === targetDate.toDateString()
    );
    
    if (!day) {
      return res.status(404).json({ message: 'Day not found' });
    }
    
    // Get professional's schedule for the day
    const professionalSchedule = day.professionals.find(prof => 
      prof.professionalId.toString() === professionalId && 
      prof.professionalType === professionalType
    );
    
    if (!professionalSchedule || !professionalSchedule.isAvailable) {
      return res.json({ success: true, availableSlots: [] });
    }
    
    // Get professional's regular availability for this day of week
    const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const dayAvailability = professional.availability?.find(a => a.day === dayName);
    
    if (!dayAvailability) {
      return res.json({ success: true, availableSlots: [] });
    }
    
    // Filter out booked slots and breaks
    const bookedSlots = professionalSchedule.bookedSlots || [];
    const breaks = professionalSchedule.breaks || [];
    
    const availableSlots = dayAvailability.slots.filter(slot => {
      // Check if slot is booked
      const isBooked = bookedSlots.some(booked => 
        booked.startTime === slot.startTime && booked.endTime === slot.endTime
      );
      
      // Check if slot falls within a break
      const isInBreak = breaks.some(br => {
        const breakStart = timeToMinutes(br.startTime);
        const breakEnd = timeToMinutes(br.endTime);
        const slotStart = timeToMinutes(slot.startTime);
        const slotEnd = timeToMinutes(slot.endTime);
        
        return (slotStart >= breakStart && slotStart < breakEnd) ||
               (slotEnd > breakStart && slotEnd <= breakEnd);
      });
      
      return !isBooked && !isInBreak && slot.isAvailable !== false;
    });
    
    res.json({ success: true, availableSlots });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

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
    
    const targetDate = new Date(date);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    let calendar = await Calendar.findOne({ year, month });
    
    if (!calendar) {
      calendar = await initializeCalendar(year, month);
    }
    
    const dayIndex = calendar.days.findIndex(d => 
      d.date.toDateString() === targetDate.toDateString()
    );
    
    if (dayIndex === -1) {
      return res.status(404).json({ message: 'Day not found in calendar' });
    }
    
    let professionalIndex = calendar.days[dayIndex].professionals.findIndex(prof => 
      prof.professionalId.toString() === professionalId && 
      prof.professionalType === professionalType
    );
    
    if (professionalIndex === -1) {
      calendar.days[dayIndex].professionals.push({
        professionalId,
        professionalType,
        bookedSlots: [{
          appointmentId,
          patientId,
          startTime,
          endTime,
          status: 'booked'
        }],
        breaks: [],
        isAvailable: true
      });
    } else {
      calendar.days[dayIndex].professionals[professionalIndex].bookedSlots.push({
        appointmentId,
        patientId,
        startTime,
        endTime,
        status: 'booked'
      });
    }
    
    await calendar.save();
    
    res.json({ success: true, message: 'Slot booked successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper functions
async function initializeCalendar(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = [];
  
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    days.push({
      date,
      dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
      isHoliday: false,
      professionals: []
    });
  }
  
  const calendar = await Calendar.create({ year, month, days });
  return calendar;
}

function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}