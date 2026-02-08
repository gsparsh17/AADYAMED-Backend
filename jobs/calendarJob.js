const cron = require('node-cron');
const Calendar = require('../models/Calendar');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const Appointment = require('../models/Appointment');

// ========== HELPERS (TIME/DATE SAFE) ==========

// Local date key (prevents IST/UTC off-by-one bugs)
function dateKeyLocal(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function ymFromDate(d) {
  const dt = new Date(d);
  return { year: dt.getFullYear(), month: dt.getMonth() + 1 };
}

function dayNameLower(d) {
  return new Date(d).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
}

function titleCaseDayName(dnLower) {
  return dnLower.charAt(0).toUpperCase() + dnLower.slice(1);
}

// Availability slots -> workingHours (simple copy, no time conversion)
function toWorkingHoursFromAvailabilitySlots(slots) {
  if (!Array.isArray(slots)) return [];
  return slots
    .filter(s => s && s.startTime && s.endTime)
    .map(s => ({
      startTime: String(s.startTime),
      endTime: String(s.endTime),
    }));
}

// ========== CALENDAR MAINTENANCE JOBS ==========

let isProcessing = false;

/**
 * Main calendar maintenance job
 * Runs daily at 2:00 AM and also triggered on availability changes
 */
async function calendarMaintenanceJob() {
  if (isProcessing) {
    console.log('⏸️ Calendar maintenance already in progress, skipping...');
    return;
  }

  isProcessing = true;
  const startTime = Date.now();
  console.log('🕒 Starting calendar maintenance job...');

  try {
    const today = startOfLocalDay(new Date());

    // 1) Update bookedSlots from appointments (truth)
    await updateExistingCalendarsWithAppointments(today);

    // 2) Ensure current + next 2 months calendars exist
    await initializeFutureCalendars(today);

    // 3) Clean old calendars
    await cleanOldCalendars(today);

    // 4) Sync workingHours from professional availability (NO bookedSlots here)
    await syncCalendarsWithProfessionalAvailability();

    const duration = Date.now() - startTime;
    console.log(`✅ Calendar maintenance completed in ${duration}ms`);
  } catch (error) {
    console.error('❌ Calendar maintenance job failed:', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * Update existing calendars with current appointments
 */
async function updateExistingCalendarsWithAppointments(today) {
  console.log('🔄 Step 1: Updating existing calendars with appointments...');

  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;

  const targets = [];
  for (let i = 0; i < 4; i++) {
    const t = new Date(currentYear, currentMonth - 1 + i, 1);
    targets.push({ year: t.getFullYear(), month: t.getMonth() + 1 });
  }

  const calendars = await Calendar.find({ $or: targets });

  let updatedCount = 0;
  for (const calendar of calendars) {
    const updated = await syncCalendarWithAppointments(calendar);
    if (updated) updatedCount++;
  }

  console.log(`   ✅ Updated ${updatedCount} calendars with appointments`);
}

/**
 * Sync a single calendar with current appointments
 * - bookedSlots ONLY from Appointment
 * - does NOT touch workingHours (availability handled elsewhere)
 */
async function syncCalendarWithAppointments(calendar) {
  try {
    let needsUpdate = false;

    const startDate = startOfLocalDay(new Date(calendar.year, calendar.month - 1, 1));
    const endDate = endOfLocalDay(new Date(calendar.year, calendar.month, 0));

    const appointments = await Appointment.find({
      appointmentDate: { $gte: startDate, $lte: endDate },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    }).select('_id patientId appointmentDate startTime endTime createdAt status professionalType doctorId physiotherapistId pathologyId');

    const apptsByDay = new Map();
    for (const a of appointments) {
      if (!a.patientId) continue; // Calendar schema requires patientId in bookedSlots
      const k = dateKeyLocal(a.appointmentDate);
      if (!apptsByDay.has(k)) apptsByDay.set(k, []);
      apptsByDay.get(k).push(a);
    }

    // Ensure calendar.days exists
    calendar.days = calendar.days || [];

    for (const dayObj of calendar.days) {
      dayObj.professionals = dayObj.professionals || [];
      for (const p of dayObj.professionals) {
        // strip invalid bookedSlots (appointments that no longer exist)
        const dayKey = dateKeyLocal(dayObj.date);
        const validAppts = apptsByDay.get(dayKey) || [];

        const validBooked = (p.bookedSlots || []).filter(slot =>
          validAppts.some(a => String(a._id) === String(slot.appointmentId))
        );

        if ((p.bookedSlots || []).length !== validBooked.length) {
          p.bookedSlots = validBooked;
          needsUpdate = true;
        }
      }
    }

    // Add missing appointment bookedSlots
    for (const [dayKey, appts] of apptsByDay.entries()) {
      // find/create day
      let dayObj = calendar.days.find(d => dateKeyLocal(d.date) === dayKey);
      if (!dayObj) {
        const parts = dayKey.split('-').map(Number);
        const dt = startOfLocalDay(new Date(parts[0], parts[1] - 1, parts[2]));
        dayObj = {
          date: dt,
          dayName: titleCaseDayName(dayNameLower(dt)),
          isHoliday: false,
          professionals: []
        };
        calendar.days.push(dayObj);
        needsUpdate = true;
      }

      for (const a of appts) {
        const professionalType = a.professionalType;
        const professionalId = a[`${professionalType}Id`];
        if (!professionalId) continue;

        let prof = (dayObj.professionals || []).find(p =>
          String(p.professionalId) === String(professionalId) &&
          p.professionalType === professionalType
        );

        if (!prof) {
          prof = {
            professionalId,
            professionalType,
            bookedSlots: [],
            breaks: [],
            workingHours: [],   // availability sync fills this later
            isAvailable: true
          };
          dayObj.professionals.push(prof);
          needsUpdate = true;
        }

        const exists = (prof.bookedSlots || []).some(s => String(s.appointmentId) === String(a._id));
        if (!exists) {
          prof.bookedSlots.push({
            appointmentId: a._id,
            patientId: a.patientId,
            startTime: a.startTime,
            endTime: a.endTime,
            bookedAt: a.createdAt || new Date(),
            status: a.status || 'booked'
          });
          needsUpdate = true;
        }
      }
    }

    if (needsUpdate) {
      calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
      calendar.markModified('days');
      await calendar.save();
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error syncing calendar with appointments:', error);
    return false;
  }
}

/**
 * Initialize calendars for current + next 2 months
 */
async function initializeFutureCalendars(today) {
  console.log('📅 Step 2: Initializing current and future calendars...');

  for (let i = 0; i < 3; i++) {
    const targetDate = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;

    const existing = await Calendar.findOne({ year, month });
    if (existing) {
      console.log(`   ⏭️ Calendar for ${month}/${year} already exists`);
      continue;
    }

    const calendar = await initializeCalendarForMonth(year, month);
    if (calendar) {
      console.log(`   ✅ Created calendar for ${month}/${year} with ${calendar.days.length} days`);
    }
  }
}

/**
 * Clean calendars older than 3 months
 */
async function cleanOldCalendars(today) {
  console.log('🧹 Step 3: Cleaning old calendars...');

  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const result = await Calendar.deleteMany({
    $or: [
      { year: { $lt: threeMonthsAgo.getFullYear() } },
      {
        year: threeMonthsAgo.getFullYear(),
        month: { $lt: threeMonthsAgo.getMonth() + 1 }
      }
    ]
  });

  if (result.deletedCount > 0) {
    console.log(`   ✅ Cleaned ${result.deletedCount} old calendars`);
  } else {
    console.log('   ✅ No old calendars to clean');
  }
}

/**
 * Sync calendars with professional availability
 * - updates ONLY workingHours/isAvailable
 * - NEVER writes fake "slots" into bookedSlots
 */
async function syncCalendarsWithProfessionalAvailability() {
  console.log('🔄 Step 4: Syncing with professional availability...');

  const doctors = await DoctorProfile.find({
    verificationStatus: 'approved'
  }).populate('userId', 'isVerified isActive');

  const physios = await PhysiotherapistProfile.find({
    verificationStatus: 'approved'
  }).populate('userId', 'isVerified isActive');

  const pathologists = await PathologyProfile.find({
    verificationStatus: 'approved'
  }).populate('userId', 'isVerified isActive');

  console.log(`   👨‍⚕️ Found ${doctors.length} approved doctors`);
  console.log(`   🏃 Found ${physios.length} approved physiotherapists`);
  console.log(`   🧪 Found ${pathologists.length} approved pathologists`);

  const today = startOfLocalDay(new Date());
  const targets = [];
  for (let i = 0; i < 3; i++) {
    const t = new Date(today.getFullYear(), today.getMonth() + i, 1);
    targets.push({ year: t.getFullYear(), month: t.getMonth() + 1 });
  }

  const calendars = await Calendar.find({ $or: targets });

  let updatedCount = 0;

  for (const calendar of calendars) {
    let needsUpdate = false;
    calendar.days = calendar.days || [];

    for (const day of calendar.days) {
      const dn = dayNameLower(day.date);
      day.professionals = day.professionals || [];

      // --- Doctors ---
      for (const doctor of doctors) {
        const active = doctor.userId?.isVerified && doctor.userId?.isActive;
        const dayAvailability = doctor.availability?.find(a => a.day === dn);
        const derivedWorkingHours = toWorkingHoursFromAvailabilitySlots(dayAvailability?.slots);
        const hasAvailability = active && derivedWorkingHours.length > 0;

        const idx = day.professionals.findIndex(p =>
          String(p.professionalId) === String(doctor._id) &&
          p.professionalType === 'doctor'
        );

        if (!hasAvailability) {
          // remove only if no bookings too
          if (idx !== -1) {
            const existing = day.professionals[idx];
            const hasBookings = (existing.bookedSlots || []).length > 0;
            if (!hasBookings) {
              day.professionals.splice(idx, 1);
              needsUpdate = true;
            } else {
              // keep bookings, just mark unavailable
              existing.workingHours = [];
              existing.isAvailable = false;
              needsUpdate = true;
            }
          }
          continue;
        }

        if (idx === -1) {
          day.professionals.push({
            professionalId: doctor._id,
            professionalType: 'doctor',
            bookedSlots: [],
            breaks: [],
            workingHours: derivedWorkingHours,
            isAvailable: true
          });
          needsUpdate = true;
        } else {
          const existing = day.professionals[idx];
          existing.workingHours = derivedWorkingHours;
          existing.isAvailable = true;
          existing.breaks = existing.breaks || [];
          existing.bookedSlots = existing.bookedSlots || [];
          needsUpdate = true;
        }
      }

      // (Optional) physios/pathologists workingHours sync can be added similarly.
      // For now you had empty arrays, so leaving them out is safe and avoids schema issues.
    }

    if (needsUpdate) {
      calendar.days.sort((a, b) => new Date(a.date) - new Date(b.date));
      calendar.markModified('days');
      await calendar.save();
      updatedCount++;
      console.log(`   💾 Saved calendar ${calendar.month}/${calendar.year}`);
    }
  }

  console.log(`   ✅ Updated ${updatedCount} calendars with professional availability`);
}

/**
 * Initialize calendar for month
 * - builds days
 * - puts availability into workingHours
 * - bookedSlots starts empty
 */
async function initializeCalendarForMonth(year, month) {
  try {
    if (month < 1 || month > 12) return null;

    const today = startOfLocalDay(new Date());
    const isCurrentMonth =
      year === today.getFullYear() &&
      month === today.getMonth() + 1;

    const isFutureMonth =
      year > today.getFullYear() ||
      (year === today.getFullYear() && month > today.getMonth() + 1);

    if (!isCurrentMonth && !isFutureMonth) {
      console.log(`   ⏭️ Skipping ${month}/${year} (past month)`);
      return null;
    }

    const existing = await Calendar.findOne({ year, month });
    if (existing) {
      console.log(`   ✅ Calendar for ${month}/${year} already exists`);
      return existing;
    }

    console.log(`   📅 Creating calendar for ${month}/${year}...`);

    const doctors = await DoctorProfile.find({
      verificationStatus: 'approved'
    }).populate('userId', 'isVerified isActive');

    console.log(`   👨‍⚕️ Found ${doctors.length} approved doctors for calendar initialization`);

    const daysInMonth = new Date(year, month, 0).getDate();
    const days = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const date = startOfLocalDay(new Date(year, month - 1, d));
      const dnLower = dayNameLower(date);

      const professionals = [];

      for (const doctor of doctors) {
        const active = doctor.userId?.isVerified && doctor.userId?.isActive;
        if (!active) continue;

        const dayAvailability = doctor.availability?.find(a => a.day === dnLower);
        const workingHours = toWorkingHoursFromAvailabilitySlots(dayAvailability?.slots);
        if (workingHours.length > 0) {
          professionals.push({
            professionalId: doctor._id,
            professionalType: 'doctor',
            bookedSlots: [],       // IMPORTANT: bookings only
            breaks: [],
            workingHours,          // availability here
            isAvailable: true
          });
        }
      }

      days.push({
        date,
        dayName: titleCaseDayName(dnLower),
        isHoliday: false,
        professionals
      });
    }

    const calendar = await Calendar.create({ year, month, days });
    console.log(`   ✅ Calendar for ${month}/${year} created with ${days.length} days`);
    return calendar;
  } catch (error) {
    console.error(`❌ Error initializing calendar for ${month}/${year}:`, error.message);
    return null;
  }
}

/**
 * Update doctor in calendar (availability + bookings truth)
 * IMPORTANT: re-fetch latest doctor profile to avoid stale data.
 */
async function updateDoctorInCalendar(doctorId) {
  try {
    const updatedDoctor = await DoctorProfile.findById(doctorId).populate('userId', 'isVerified isActive');
    console.log(`🔄 Updating calendar for Doctor ID: ${doctorId} (${updatedDoctor?.name || ''})`);

    const today = startOfLocalDay(new Date());

    // Update next 90 days
    const datesToUpdate = [];
    for (let i = 0; i <= 90; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      datesToUpdate.push(startOfLocalDay(d));
    }

    // cache calendars by monthKey to avoid re-querying
    const calCache = new Map();
    const processedMonthKeys = new Set();

    let totalUpdates = 0;

    for (const targetDate of datesToUpdate) {
      const { year, month } = ymFromDate(targetDate);
      const monthKey = `${year}-${month}`;
      processedMonthKeys.add(monthKey);

      let calendar = calCache.get(monthKey);
      if (!calendar) {
        calendar = await Calendar.findOne({ year, month });
        if (!calendar) {
          calendar = await initializeCalendarForMonth(year, month);
          if (!calendar) continue;
        }
        calCache.set(monthKey, calendar);
      }

      calendar.days = calendar.days || [];

      const dayKey = dateKeyLocal(targetDate);
      let dayObj = calendar.days.find(d => dateKeyLocal(d.date) === dayKey);

      const dn = dayNameLower(targetDate);
      const dayAvailability = updatedDoctor?.availability?.find(a => a.day === dn);
      const derivedWorkingHours = toWorkingHoursFromAvailabilitySlots(dayAvailability?.slots);

      const dayStart = startOfLocalDay(targetDate);
      const dayEnd = endOfLocalDay(targetDate);

      // bookings truth: appointments on that day
      const actualAppointments = await Appointment.find({
        doctorId: doctorId,
        appointmentDate: { $gte: dayStart, $lte: dayEnd },
        status: { $in: ['pending', 'confirmed', 'accepted'] }
      }).select('_id patientId startTime endTime createdAt status');

      const bookedSlotsFromAppointments = actualAppointments
        .filter(a => a.patientId) // schema requires patientId
        .map(a => ({
          appointmentId: a._id,
          patientId: a.patientId,
          startTime: a.startTime,
          endTime: a.endTime,
          bookedAt: a.createdAt || new Date(),
          status: a.status || 'booked'
        }));

      const hasAvailability = derivedWorkingHours.length > 0;
      const hasBookings = bookedSlotsFromAppointments.length > 0;

      if (!dayObj) {
        // create day only if needed
        if (hasAvailability || hasBookings) {
          dayObj = {
            date: dayStart,
            dayName: titleCaseDayName(dn),
            isHoliday: false,
            professionals: []
          };
          calendar.days.push(dayObj);
          totalUpdates++;
          console.log(`   📅 Created day ${dayKey}: availability=${hasAvailability}, bookings=${bookedSlotsFromAppointments.length}`);
        } else {
          continue;
        }
      }

      dayObj.professionals = dayObj.professionals || [];

      const profIndex = dayObj.professionals.findIndex(p =>
        String(p.professionalId) === String(doctorId) &&
        p.professionalType === 'doctor'
      );

      if (profIndex === -1) {
        if (hasAvailability || hasBookings) {
          dayObj.professionals.push({
            professionalId: doctorId,
            professionalType: 'doctor',
            workingHours: derivedWorkingHours,
            breaks: [],
            isAvailable: hasAvailability,
            bookedSlots: bookedSlotsFromAppointments
          });
          totalUpdates++;
          console.log(`   ➕ Added doctor to ${dayKey}: availability=${hasAvailability}, bookings=${bookedSlotsFromAppointments.length}`);
        }
      } else {
        const prof = dayObj.professionals[profIndex];

        if (!hasAvailability && !hasBookings) {
          dayObj.professionals.splice(profIndex, 1);
          totalUpdates++;
          console.log(`   ➖ Removed doctor from ${dayKey} (no availability + no bookings)`);
        } else {
          prof.workingHours = derivedWorkingHours;                // <-- THIS is your availability
          prof.isAvailable = hasAvailability;
          prof.bookedSlots = bookedSlotsFromAppointments;         // <-- bookings only
          prof.breaks = prof.breaks || [];
          totalUpdates++;
          console.log(`   🔄 Updated ${dayKey}: availability=${hasAvailability}, bookings=${bookedSlotsFromAppointments.length}`);
        }
      }

      calendar.markModified('days');
    }

    // save all processed calendars
    for (const monthKey of processedMonthKeys) {
      const cal = calCache.get(monthKey);
      if (!cal) continue;
      cal.days.sort((a, b) => new Date(a.date) - new Date(b.date));
      cal.markModified('days');
      await cal.save();
      const [y, m] = monthKey.split('-');
      console.log(`   💾 Saved calendar for ${m}/${y}`);
    }

    console.log(`✅ Calendar updated for Doctor ${updatedDoctor?.name || doctorId}, affected days: ${totalUpdates}`);
    return { success: true, totalUpdates };
  } catch (error) {
    console.error('❌ Error in updateDoctorInCalendar:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Quick availability sync
 */
async function quickAvailabilitySync(doctorId) {
  try {
    console.log(`⚡ Quick availability sync for doctor ${doctorId}`);
    return await updateDoctorInCalendar(doctorId);
  } catch (error) {
    console.error('❌ Error in quickAvailabilitySync:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Manual trigger
 */
async function manualCalendarMaintenance() {
  console.log('🚀 Manual calendar maintenance triggered');
  await calendarMaintenanceJob();
}

/**
 * Inconsistency fix: ensure appointments exist in bookedSlots (safe)
 */
async function fixCalendarInconsistencies() {
  console.log('🔧 Checking for calendar inconsistencies...');

  const today = new Date();
  const { year, month } = ymFromDate(today);

  let calendar = await Calendar.findOne({ year, month });
  if (!calendar) calendar = await initializeCalendarForMonth(year, month);
  if (!calendar) return;

  // Just re-run appointment sync for current month
  const updated = await syncCalendarWithAppointments(calendar);
  if (updated) {
    console.log('✅ Calendar inconsistencies fixed by re-syncing appointments');
  } else {
    console.log('✅ No inconsistencies found');
  }
}

// ========== SCHEDULE JOBS ==========

cron.schedule('0 2 * * *', calendarMaintenanceJob);

cron.schedule('0 */3 * * *', async () => {
  console.log('🔄 Running quick calendar sync (appointments)...');
  const today = new Date();
  await updateExistingCalendarsWithAppointments(today);
});

cron.schedule('0 */2 * * *', async () => {
  console.log('📅 Running availability sync...');
  await syncCalendarsWithProfessionalAvailability();
});

cron.schedule('0 4 * * *', fixCalendarInconsistencies);

// Startup
setTimeout(() => {
  console.log('🚀 Starting calendar system...');
  calendarMaintenanceJob().catch(console.error);
}, 10000);

// ========== EXPORTS ==========

module.exports = {
  calendarMaintenanceJob,
  manualCalendarMaintenance,
  fixCalendarInconsistencies,
  syncCalendarWithAppointments,
  initializeCalendarForMonth,
  updateExistingCalendarsWithAppointments,
  cleanOldCalendars,
  syncCalendarsWithProfessionalAvailability,
  quickAvailabilitySync,
  updateDoctorInCalendar
};
