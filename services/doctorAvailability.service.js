const Appointment = require('../models/Appointment');
const Calendar = require('../models/Calendar');

const ACTIVE_APPOINTMENT_STATUSES = ['pending', 'confirmed', 'accepted', 'rescheduled', 'in_progress'];
const VALID_TYPES = ['clinic', 'home', 'video'];

function parseLocalDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return date;
    }
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function localDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timeToMinutes(value) {
  const match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(value) {
  const minutes = Math.max(0, Math.min(1439, Number(value) || 0));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function addMinutes(time, duration) {
  const start = timeToMinutes(time);
  if (start === null) return null;
  return minutesToTime(start + Number(duration || 0));
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function getDoctorTypeEnabled(doctor, type) {
  if (!VALID_TYPES.includes(type)) return false;
  if (type === 'clinic') return doctor.clinicConsultationEnabled !== false;
  if (type === 'home') {
    return doctor.homeVisitEnabled === true || (doctor.homeVisitEnabled == null && Number(doctor.homeVisitFee || 0) > 0);
  }
  return doctor.teleconsultationEnabled === true || (doctor.teleconsultationEnabled == null && Number(doctor.videoCallFee || 0) > 0);
}

function getDoctorFee(doctor, type) {
  if (type === 'home') return Number(doctor.homeVisitFee || doctor.consultationFee || 0);
  if (type === 'video') return Number(doctor.videoCallFee || doctor.consultationFee || 0);
  return Number(doctor.consultationFee || 0);
}

function getConsultationTypes(doctor) {
  return VALID_TYPES.filter((type) => getDoctorTypeEnabled(doctor, type)).map((type) => ({
    type,
    fee: getDoctorFee(doctor, type),
  }));
}

function normalizeSlotDuration(doctor, requestedDuration) {
  const requested = Number(requestedDuration);
  const configured = Number(doctor.slotDurationMinutes || 30);
  const value = Number.isFinite(requested) && requested >= 5 && requested <= 180 ? requested : configured;
  return Math.max(5, Math.min(180, value));
}

function getDaySchedule(doctor, date, type) {
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const day = (doctor.availability || []).find((item) => String(item.day).toLowerCase() === dayName);
  if (!day) return { dayName, blocks: [] };

  const allBlocks = Array.isArray(day.slots) ? day.slots : [];
  let blocks = allBlocks.filter((slot) => {
    const slotType = slot.type || 'clinic';
    return slotType === 'all' || slotType === type;
  });

  // Backward compatibility: older doctor records used clinic ranges as the only
  // weekly schedule even when video consultation was enabled.
  if (!blocks.length && type === 'video' && getDoctorTypeEnabled(doctor, 'video')) {
    blocks = allBlocks.filter((slot) => (slot.type || 'clinic') === 'clinic' || slot.type === 'all');
  }

  return { dayName, blocks };
}

async function getCalendarBreaks(doctorId, date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const calendar = await Calendar.findOne({ year, month }).select('days').lean();
  if (!calendar?.days?.length) return [];

  const key = localDateKey(date);
  const day = calendar.days.find((item) => localDateKey(item.date) === key);
  const schedule = day?.professionals?.find(
    (item) => String(item.professionalId) === String(doctorId) && item.professionalType === 'doctor'
  );
  return Array.isArray(schedule?.breaks) ? schedule.breaks : [];
}

async function getDoctorDailySlots(doctor, dateInput, options = {}) {
  const date = parseLocalDate(dateInput);
  if (!date) {
    const error = new Error('Invalid date. Use YYYY-MM-DD.');
    error.statusCode = 400;
    throw error;
  }

  const type = VALID_TYPES.includes(options.type) ? options.type : 'clinic';
  if (!getDoctorTypeEnabled(doctor, type)) {
    return {
      date: localDateKey(date),
      dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
      type,
      fee: getDoctorFee(doctor, type),
      slotDuration: normalizeSlotDuration(doctor, options.duration),
      isAvailable: false,
      slots: [],
      reason: 'consultation_type_disabled',
    };
  }

  const today = startOfDay(new Date());
  const target = startOfDay(date);
  if (target < today) {
    const error = new Error('Cannot request availability for a past date');
    error.statusCode = 400;
    throw error;
  }

  const bookingWindowDays = Math.max(1, Math.min(365, Number(doctor.bookingWindowDays || 60)));
  const latest = new Date(today);
  latest.setDate(latest.getDate() + bookingWindowDays);
  if (target > latest) {
    return {
      date: localDateKey(date),
      dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
      type,
      fee: getDoctorFee(doctor, type),
      slotDuration: normalizeSlotDuration(doctor, options.duration),
      isAvailable: false,
      slots: [],
      reason: 'outside_booking_window',
    };
  }

  const slotDuration = normalizeSlotDuration(doctor, options.duration);
  const { dayName, blocks } = getDaySchedule(doctor, target, type);
  if (!blocks.length) {
    return {
      date: localDateKey(date),
      dayName,
      type,
      fee: getDoctorFee(doctor, type),
      slotDuration,
      isAvailable: false,
      slots: [],
      reason: 'not_scheduled',
    };
  }

  const [appointments, breaks] = await Promise.all([
    Appointment.find({
      doctorId: doctor._id,
      professionalType: 'doctor',
      appointmentDate: { $gte: startOfDay(target), $lte: endOfDay(target) },
      status: { $in: ACTIVE_APPOINTMENT_STATUSES },
    }).select('startTime endTime duration type status').lean(),
    getCalendarBreaks(doctor._id, target),
  ]);

  const now = new Date();
  const isToday = localDateKey(now) === localDateKey(target);
  const minimumNoticeMinutes = Math.max(0, Math.min(10080, Number(doctor.minimumNoticeMinutes || 60)));
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const minimumStartMinutes = isToday ? nowMinutes + minimumNoticeMinutes : 0;

  const slots = [];
  const dedupe = new Set();

  for (const block of blocks) {
    const blockStart = timeToMinutes(block.startTime);
    const blockEnd = timeToMinutes(block.endTime);
    if (blockStart === null || blockEnd === null || blockEnd <= blockStart) continue;

    const maxPatients = Math.max(1, Number(block.maxPatients || 1));
    for (let cursor = blockStart; cursor + slotDuration <= blockEnd; cursor += slotDuration) {
      const slotEnd = cursor + slotDuration;
      if (cursor < minimumStartMinutes) continue;

      const startTime = minutesToTime(cursor);
      const endTime = minutesToTime(slotEnd);
      const dedupeKey = `${startTime}-${endTime}-${type}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);

      const isBreak = breaks.some((item) => {
        const breakStart = timeToMinutes(item.startTime);
        const breakEnd = timeToMinutes(item.endTime);
        return breakStart !== null && breakEnd !== null && overlaps(cursor, slotEnd, breakStart, breakEnd);
      });
      if (isBreak) continue;

      const occupied = appointments.filter((appointment) => {
        const appointmentStart = timeToMinutes(appointment.startTime);
        const appointmentEnd = timeToMinutes(appointment.endTime) ?? (
          appointmentStart === null ? null : appointmentStart + Number(appointment.duration || slotDuration)
        );
        return appointmentStart !== null && appointmentEnd !== null && overlaps(cursor, slotEnd, appointmentStart, appointmentEnd);
      }).length;

      const remainingCapacity = Math.max(0, maxPatients - occupied);
      slots.push({
        startTime,
        endTime,
        type,
        fee: getDoctorFee(doctor, type),
        duration: slotDuration,
        maxPatients,
        remainingCapacity,
        isAvailable: remainingCapacity > 0,
      });
    }
  }

  return {
    date: localDateKey(target),
    dayName,
    type,
    fee: getDoctorFee(doctor, type),
    slotDuration,
    isAvailable: slots.some((slot) => slot.isAvailable),
    slots: options.includeUnavailable ? slots : slots.filter((slot) => slot.isAvailable),
  };
}

async function getNextAvailableSlot(doctor, options = {}) {
  const type = VALID_TYPES.includes(options.type) ? options.type : 'clinic';
  const daysToScan = Math.max(1, Math.min(Number(options.daysToScan || 14), Number(doctor.bookingWindowDays || 60)));
  const start = startOfDay(options.fromDate ? parseLocalDate(options.fromDate) || new Date() : new Date());

  for (let offset = 0; offset <= daysToScan; offset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const daily = await getDoctorDailySlots(doctor, date, { type, duration: options.duration });
    if (daily.slots.length) {
      return {
        date: daily.date,
        dayName: daily.dayName,
        ...daily.slots[0],
      };
    }
  }
  return null;
}

module.exports = {
  ACTIVE_APPOINTMENT_STATUSES,
  VALID_TYPES,
  parseLocalDate,
  localDateKey,
  timeToMinutes,
  minutesToTime,
  addMinutes,
  getDoctorFee,
  getDoctorTypeEnabled,
  getConsultationTypes,
  getDoctorDailySlots,
  getNextAvailableSlot,
};
