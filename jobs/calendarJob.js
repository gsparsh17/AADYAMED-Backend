const cron = require('node-cron');
const Calendar = require('../models/Calendar');
const DoctorProfile = require('../models/DoctorProfile');
const PhysiotherapistProfile = require('../models/PhysiotherapistProfile');
const PathologyProfile = require('../models/PathologyProfile');
const Appointment = require('../models/Appointment');

// ========== CALENDAR MAINTENANCE JOBS ==========

let isProcessing = false;

/**
 * Main calendar maintenance job
 * Runs daily at 2:00 AM
 */
async function calendarMaintenanceJob() {
  // Prevent concurrent execution
  if (isProcessing) {
    console.log('⏸️ Calendar maintenance already in progress, skipping...');
    return;
  }

  isProcessing = true;
  const startTime = Date.now();
  console.log('🕒 Starting calendar maintenance job...');

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // 1. UPDATE EXISTING CALENDARS with current appointments
    await updateExistingCalendarsWithAppointments(today);
    
    // 2. INITIALIZE FUTURE CALENDARS (next 3 months)
    await initializeFutureCalendars(today);
    
    // 3. CLEAN OLD CALENDARS (older than 3 months)
    await cleanOldCalendars(today);
    
    // 4. SYNC CALENDAR WITH PROFESSIONAL AVAILABILITY
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
  
  // Get all calendars for current and next month
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  
  const calendars = await Calendar.find({
    $or: [
      { year: currentYear, month: currentMonth },
      { 
        year: currentYear, 
        month: currentMonth + 1 
      },
      {
        year: currentYear + (currentMonth === 12 ? 1 : 0),
        month: currentMonth === 12 ? 1 : currentMonth + 1
      }
    ]
  });
  
  let updatedCount = 0;
  
  for (const calendar of calendars) {
    const updated = await syncCalendarWithAppointments(calendar);
    if (updated) updatedCount++;
  }
  
  console.log(`   ✅ Updated ${updatedCount} calendars with appointments`);
}

/**
 * Initialize calendars for future months
 */
async function initializeFutureCalendars(today) {
  console.log('📅 Step 2: Initializing current and future calendars...');
  
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  
  // Initialize current month and next 2 months (total of 3 months)
  for (let i = 0; i < 3; i++) {
    const targetDate = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth() + 1;
    
    // Skip if already exists
    const existing = await Calendar.findOne({ year, month });
    if (existing) {
      console.log(`   ⏭️ Calendar for ${month}/${year} already exists`);
      continue;
    }
    
    // Initialize calendar
    const calendar = await initializeCalendarForMonth(year, month);
    if (calendar) {
      console.log(`   ✅ Created calendar for ${month}/${year}`);
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
 * Sync calendars with professional availability changes
 */
async function syncCalendarsWithProfessionalAvailability() {
  console.log('🔄 Step 4: Syncing with professional availability...');
  
  // Get active professionals
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
  
  // Get current and next month's calendars
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  
  const calendars = await Calendar.find({
    $or: [
      { year: currentYear, month: currentMonth },
      { 
        year: currentYear, 
        month: currentMonth + 1 
      }
    ]
  });
  
  let updatedCount = 0;
  
  for (const calendar of calendars) {
    let needsUpdate = false;
    
    for (const day of calendar.days) {
      const date = new Date(day.date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
      
      // Update doctors
      for (const doctor of doctors) {
        if (!doctor.userId?.isVerified || !doctor.userId?.isActive) {
          // Remove if doctor is no longer active
          const index = day.professionals.findIndex(p => 
            p.professionalId.toString() === doctor._id.toString() && 
            p.professionalType === 'doctor'
          );
          if (index !== -1) {
            day.professionals.splice(index, 1);
            needsUpdate = true;
          }
          continue;
        }
        
        const dayAvailability = doctor.availability?.find(a => a.day === dayName);
        const shouldBeAvailable = dayAvailability && dayAvailability.slots?.length > 0;
        
        const existingIndex = day.professionals.findIndex(p => 
          p.professionalId.toString() === doctor._id.toString() && 
          p.professionalType === 'doctor'
        );
        
        if (shouldBeAvailable && existingIndex === -1) {
          // Add doctor if they should be available
          day.professionals.push({
            professionalId: doctor._id,
            professionalType: 'doctor',
            bookedSlots: [],
            breaks: [],
            workingHours: [],
            isAvailable: true
          });
          needsUpdate = true;
        } else if (!shouldBeAvailable && existingIndex !== -1) {
          // Remove doctor if they shouldn't be available
          day.professionals.splice(existingIndex, 1);
          needsUpdate = true;
        }
      }
      
      // Similar logic for physios and pathologists...
    }
    
    if (needsUpdate) {
      await calendar.save();
      updatedCount++;
    }
  }
  
  console.log(`   ✅ Updated ${updatedCount} calendars with professional availability`);
}

/**
 * Sync a single calendar with current appointments
 */
async function syncCalendarWithAppointments(calendar) {
  try {
    let needsUpdate = false;
    
    // Get all appointments for this month
    const startDate = new Date(calendar.year, calendar.month - 1, 1);
    const endDate = new Date(calendar.year, calendar.month, 0);
    endDate.setHours(23, 59, 59, 999);
    
    const appointments = await Appointment.find({
      appointmentDate: {
        $gte: startDate,
        $lte: endDate
      },
      status: { $in: ['pending', 'confirmed', 'accepted'] }
    });
    
    // Clear existing booked slots (we'll rebuild from appointments)
    for (const day of calendar.days) {
      for (const professional of day.professionals) {
        if (professional.bookedSlots.length > 0) {
          professional.bookedSlots = [];
          needsUpdate = true;
        }
      }
    }
    
    // Add appointments to calendar
    for (const appointment of appointments) {
      const appointmentDate = new Date(appointment.appointmentDate);
      const dateStr = appointmentDate.toISOString().split('T')[0];
      
      const day = calendar.days.find(d => {
        const dDate = new Date(d.date);
        return dDate.toISOString().split('T')[0] === dateStr;
      });
      
      if (!day) continue;
      
      const professionalType = appointment.professionalType;
      const professionalId = appointment[`${professionalType}Id`];
      
      if (!professionalId) continue;
      
      let professional = day.professionals.find(p => 
        p.professionalId.toString() === professionalId.toString() && 
        p.professionalType === professionalType
      );
      
      if (!professional) {
        // Create professional entry if not exists
        professional = {
          professionalId,
          professionalType,
          bookedSlots: [],
          breaks: [],
          workingHours: [],
          isAvailable: true
        };
        day.professionals.push(professional);
        needsUpdate = true;
      }
      
      // Add booked slot
      professional.bookedSlots.push({
        appointmentId: appointment._id,
        patientId: appointment.patientId,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        bookedAt: appointment.createdAt,
        status: 'booked'
      });
      needsUpdate = true;
    }
    
    if (needsUpdate) {
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
 * Initialize calendar for a specific month
 */
/**
 * Initialize calendar for a specific month
 */
async function initializeCalendarForMonth(year, month) {
  try {
    if (month < 1 || month > 12) return null;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Normalize today to start of day
    
    const targetDate = new Date(year, month - 1, 1);
    targetDate.setHours(0, 0, 0, 0);
    
    // Calculate the last day of the target month
    const lastDayOfMonth = new Date(year, month, 0);
    lastDayOfMonth.setHours(23, 59, 59, 999);
    
    // Allow initialization for:
    // 1. Current month (even if we're past the 1st)
    // 2. Future months
    // Don't initialize past months (older than current month)
    
    const isCurrentMonth = 
      year === today.getFullYear() && 
      month === today.getMonth() + 1;
    
    const isFutureMonth = 
      year > today.getFullYear() || 
      (year === today.getFullYear() && month > today.getMonth() + 1);
    
    // Don't initialize if it's a past month (not current, not future)
    if (!isCurrentMonth && !isFutureMonth) {
      console.log(`   ⏭️ Skipping ${month}/${year} (past month)`);
      return null;
    }
    
    // Check if calendar already exists
    const existing = await Calendar.findOne({ year, month });
    if (existing) {
      console.log(`   ✅ Calendar for ${month}/${year} already exists`);
      return existing;
    }
    
    console.log(`   📅 Creating calendar for ${month}/${year}...`);
    
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
          slotDate.setHours(0, 0, 0, 0);
          const compareDate = new Date(date);
          compareDate.setHours(0, 0, 0, 0);
          return slotDate.getTime() === compareDate.getTime();
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
    console.log(`   ✅ Calendar for ${month}/${year} created with ${days.length} days`);
    
    return calendar;
  } catch (error) {
    console.error(`❌ Error initializing calendar for ${month}/${year}:`, error.message);
    return null;
  }
}
/**
 * Manual trigger for calendar maintenance
 */
async function manualCalendarMaintenance() {
  console.log('🚀 Manual calendar maintenance triggered');
  await calendarMaintenanceJob();
}

/**
 * Check and fix calendar inconsistencies
 */
async function fixCalendarInconsistencies() {
  console.log('🔧 Checking for calendar inconsistencies...');
  
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  
  // Get appointments without corresponding calendar entries
  const startDate = new Date(currentYear, currentMonth - 1, 1);
  const endDate = new Date(currentYear, currentMonth, 0);
  endDate.setHours(23, 59, 59, 999);
  
  const appointments = await Appointment.find({
    appointmentDate: { $gte: startDate, $lte: endDate },
    status: { $in: ['pending', 'confirmed', 'accepted'] }
  });
  
  let calendar = await Calendar.findOne({ year: currentYear, month: currentMonth });
  if (!calendar) {
    calendar = await initializeCalendarForMonth(currentYear, currentMonth);
  }
  
  let fixedCount = 0;
  
  for (const appointment of appointments) {
    const appointmentDate = new Date(appointment.appointmentDate);
    const dateStr = appointmentDate.toISOString().split('T')[0];
    
    const day = calendar.days.find(d => {
      const dDate = new Date(d.date);
      return dDate.toISOString().split('T')[0] === dateStr;
    });
    
    if (!day) continue;
    
    const professionalType = appointment.professionalType;
    const professionalId = appointment[`${professionalType}Id`];
    
    if (!professionalId) continue;
    
    let professional = day.professionals.find(p => 
      p.professionalId.toString() === professionalId.toString() && 
      p.professionalType === professionalType
    );
    
    if (!professional) {
      // Create missing professional entry
      professional = {
        professionalId,
        professionalType,
        bookedSlots: [],
        breaks: [],
        workingHours: [],
        isAvailable: true
      };
      day.professionals.push(professional);
      fixedCount++;
    }
    
    // Check if appointment is already in booked slots
    const exists = professional.bookedSlots.some(slot => 
      slot.appointmentId.toString() === appointment._id.toString()
    );
    
    if (!exists) {
      professional.bookedSlots.push({
        appointmentId: appointment._id,
        patientId: appointment.patientId,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        bookedAt: appointment.createdAt,
        status: 'booked'
      });
      fixedCount++;
    }
  }
  
  if (fixedCount > 0) {
    await calendar.save();
    console.log(`✅ Fixed ${fixedCount} calendar inconsistencies`);
  } else {
    console.log('✅ No inconsistencies found');
  }
}

// ========== SCHEDULE JOBS ==========

// Main calendar maintenance: Daily at 2:00 AM
cron.schedule('0 2 * * *', calendarMaintenanceJob);

// Quick sync: Every 6 hours (for appointment updates)
cron.schedule('0 */6 * * *', async () => {
  console.log('🔄 Running quick calendar sync...');
  const today = new Date();
  await updateExistingCalendarsWithAppointments(today);
});

// Inconsistency check: Weekly on Sunday at 3:00 AM
cron.schedule('0 3 * * 0', fixCalendarInconsistencies);

// ========== STARTUP ==========

// Run maintenance on startup (after 10 seconds delay)
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
  syncCalendarsWithProfessionalAvailability
};