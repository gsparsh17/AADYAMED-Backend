const express = require('express');
const router = express.Router();
const calendarController = require('../controllers/calendarController');
const { protect, authorize } = require('../middlewares/auth');

// ========== PROTECTED ROUTES ==========
router.use(protect);

// Get calendar view (past/current/future months)
router.get('/', calendarController.getCalendar);

// Get professional schedule (single day or week view)
router.get('/professional-schedule', calendarController.getProfessionalSchedule);

// Get available slots for booking
router.get('/available-slots', calendarController.getAvailableSlots);

// ========== PROFESSIONAL SCHEDULE MANAGEMENT ==========

// Update availability (mark day available/unavailable)
router.put('/availability',
  calendarController.updateAvailability
);

// Add break to schedule
router.post('/break', 
  calendarController.addBreak
);

// Remove break from schedule
router.delete('/break/:id', 
  calendarController.removeBreak
);

// ========== APPOINTMENT BOOKING ==========

// Book a time slot
router.post('/book-slot', 
  calendarController.bookSlot
);

// ========== ADMIN CALENDAR MANAGEMENT ==========

// Initialize calendar for specific month
router.post('/initialize', 
  calendarController.initializeCalendarForMonth
);

// Clean old calendars (older than X months)
router.post('/clean-old', 
  calendarController.cleanOldCalendars
);

// Manually trigger calendar sync (for testing/debugging)
router.post('/manual-sync', 
  async (req, res) => {
    try {
      // Import the calendar jobs
      const calendarJobs = require('../jobs/calendarJob');
      await calendarJobs.manualCalendarMaintenance();
      
      res.json({
        success: true,
        message: 'Manual calendar sync completed'
      });
    } catch (error) {
      console.error('Manual sync error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to perform manual sync'
      });
    }
  }
);

// Fix calendar inconsistencies
// Access: Admin only
router.post('/fix-inconsistencies', 
  
  async (req, res) => {
    try {
      const calendarJobs = require('../jobs/calendarJob');
      await calendarJobs.fixCalendarInconsistencies();
      
      res.json({
        success: true,
        message: 'Calendar inconsistencies fixed'
      });
    } catch (error) {
      console.error('Fix inconsistencies error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fix inconsistencies'
      });
    }
  }
);

// Get calendar system status
router.get('/system-status', 
  
  async (req, res) => {
    try {
      const Calendar = require('../models/Calendar');
      const Appointment = require('../models/Appointment');
      
      const today = new Date();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth() + 1;
      
      // Count calendars
      const totalCalendars = await Calendar.countDocuments();
      
      // Count calendars by age
      const threeMonthsAgo = new Date(today);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      
      const calendarsByAge = {
        past: await Calendar.countDocuments({
          $or: [
            { year: { $lt: threeMonthsAgo.getFullYear() } },
            { 
              year: threeMonthsAgo.getFullYear(),
              month: { $lt: threeMonthsAgo.getMonth() + 1 }
            }
          ]
        }),
        recent: await Calendar.countDocuments({
          $or: [
            { year: threeMonthsAgo.getFullYear(), month: threeMonthsAgo.getMonth() + 1 },
            { year: currentYear, month: { $gte: currentMonth - 1, $lte: currentMonth } }
          ]
        }),
        future: await Calendar.countDocuments({
          $or: [
            { year: currentYear, month: { $gt: currentMonth } },
            { year: { $gt: currentYear } }
          ]
        })
      };
      
      // Get current month appointment stats
      const startDate = new Date(currentYear, currentMonth - 1, 1);
      const endDate = new Date(currentYear, currentMonth, 0);
      endDate.setHours(23, 59, 59, 999);
      
      const currentMonthAppointments = await Appointment.countDocuments({
        appointmentDate: {
          $gte: startDate,
          $lte: endDate
        }
      });
      
      res.json({
        success: true,
        status: {
          calendars: {
            total: totalCalendars,
            byAge: calendarsByAge
          },
          appointments: {
            currentMonth: currentMonthAppointments
          },
          storage: {
            strategy: 'Current + next 3 months stored, past generated on-demand',
            cleanup: 'Automatic after 3 months'
          },
          cronJobs: {
            maintenance: 'Daily at 02:00 AM',
            quickSync: 'Every 6 hours',
            consistencyCheck: 'Weekly on Sunday at 03:00 AM'
          }
        }
      });
    } catch (error) {
      console.error('System status error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get system status'
      });
    }
  }
);

// Get detailed calendar info for specific month
// Access: Admin only
router.get('/month-details/:year/:month', 
  
  async (req, res) => {
    try {
      const { year, month } = req.params;
      const Calendar = require('../models/Calendar');
      const Appointment = require('../models/Appointment');
      
      const targetYear = parseInt(year);
      const targetMonth = parseInt(month);
      
      if (targetMonth < 1 || targetMonth > 12) {
        return res.status(400).json({
          success: false,
          error: 'Month must be between 1 and 12'
        });
      }
      
      const targetDate = new Date(targetYear, targetMonth - 1, 1);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const isPastMonth = targetDate < today;
      
      let calendar = null;
      let appointments = [];
      let isGenerated = false;
      
      if (isPastMonth) {
        // Generate on-demand for past months
        const startDate = new Date(targetYear, targetMonth - 1, 1);
        const endDate = new Date(targetYear, targetMonth, 0);
        endDate.setHours(23, 59, 59, 999);
        
        appointments = await Appointment.find({
          appointmentDate: {
            $gte: startDate,
            $lte: endDate
          }
        })
        .populate('patientId', 'name')
        .populate('doctorId physioId pathologyId', 'name')
        .sort({ appointmentDate: 1, startTime: 1 });
        
        isGenerated = true;
      } else {
        // Get stored calendar
        calendar = await Calendar.findOne({ year: targetYear, month: targetMonth });
        
        if (calendar) {
          // Get appointments for comparison
          const startDate = new Date(targetYear, targetMonth - 1, 1);
          const endDate = new Date(targetYear, targetMonth, 0);
          endDate.setHours(23, 59, 59, 999);
          
          appointments = await Appointment.find({
            appointmentDate: {
              $gte: startDate,
              $lte: endDate
            },
            status: { $in: ['pending', 'confirmed', 'accepted'] }
          });
        }
      }
      
      const stats = {
        totalAppointments: appointments.length,
        byStatus: {},
        byProfessionalType: {},
        byDayOfWeek: {}
      };
      
      appointments.forEach(apt => {
        // Count by status
        stats.byStatus[apt.status] = (stats.byStatus[apt.status] || 0) + 1;
        
        // Count by professional type
        stats.byProfessionalType[apt.professionalType] = (stats.byProfessionalType[apt.professionalType] || 0) + 1;
        
        // Count by day of week
        const aptDate = new Date(apt.appointmentDate);
        const dayName = aptDate.toLocaleDateString('en-US', { weekday: 'long' });
        stats.byDayOfWeek[dayName] = (stats.byDayOfWeek[dayName] || 0) + 1;
      });
      
      res.json({
        success: true,
        month: {
          year: targetYear,
          month: targetMonth,
          monthName: targetDate.toLocaleDateString('en-US', { month: 'long' }),
          isPastMonth,
          isGeneratedOnDemand: isPastMonth && !calendar,
          hasStoredCalendar: !!calendar,
          calendarDays: calendar ? calendar.days.length : 0,
          statistics: stats
        },
        appointments: {
          total: appointments.length,
          sample: appointments.slice(0, 10) // First 10 for preview
        }
      });
    } catch (error) {
      console.error('Month details error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get month details'
      });
    }
  }
);

// Export calendar data for backup/analytics
// Access: Admin only
router.get('/export/:year/:month', 
  
  async (req, res) => {
    try {
      const { year, month } = req.params;
      const Calendar = require('../models/Calendar');
      const Appointment = require('../models/Appointment');
      
      const targetYear = parseInt(year);
      const targetMonth = parseInt(month);
      
      // Get calendar data
      let calendar = await Calendar.findOne({ year: targetYear, month: targetMonth });
      
      // Get appointments for this month
      const startDate = new Date(targetYear, targetMonth - 1, 1);
      const endDate = new Date(targetYear, targetMonth, 0);
      endDate.setHours(23, 59, 59, 999);
      
      const appointments = await Appointment.find({
        appointmentDate: {
          $gte: startDate,
          $lte: endDate
        }
      })
      .populate('patientId', 'name patientId')
      .populate('doctorId physioId pathologyId', 'name')
      .sort({ appointmentDate: 1, startTime: 1 });
      
      const exportData = {
        metadata: {
          exportDate: new Date().toISOString(),
          year: targetYear,
          month: targetMonth,
          monthName: new Date(targetYear, targetMonth - 1, 1).toLocaleDateString('en-US', { month: 'long' }),
          hasStoredCalendar: !!calendar,
          totalAppointments: appointments.length
        },
        calendar: calendar ? {
          year: calendar.year,
          month: calendar.month,
          totalDays: calendar.days.length,
          days: calendar.days.map(day => ({
            date: day.date,
            dayName: day.dayName,
            professionalsCount: day.professionals.length,
            bookedSlotsCount: day.professionals.reduce((sum, prof) => sum + prof.bookedSlots.length, 0)
          }))
        } : null,
        appointments: appointments.map(apt => ({
          id: apt._id,
          date: apt.appointmentDate,
          startTime: apt.startTime,
          endTime: apt.endTime,
          status: apt.status,
          professionalType: apt.professionalType,
          professionalId: apt[`${apt.professionalType}Id`],
          professionalName: apt[`${apt.professionalType}Id`]?.name || 'Unknown',
          patientId: apt.patientId?._id,
          patientName: apt.patientId?.name,
          patientCode: apt.patientId?.patientId,
          consultationFee: apt.consultationFee,
          paymentStatus: apt.paymentStatus,
          createdAt: apt.createdAt
        })),
        summary: {
          byStatus: appointments.reduce((acc, apt) => {
            acc[apt.status] = (acc[apt.status] || 0) + 1;
            return acc;
          }, {}),
          byProfessionalType: appointments.reduce((acc, apt) => {
            acc[apt.professionalType] = (acc[apt.professionalType] || 0) + 1;
            return acc;
          }, {}),
          revenue: appointments.reduce((sum, apt) => sum + (apt.consultationFee || 0), 0)
        }
      };
      
      // Set headers for JSON download
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=calendar-export-${targetYear}-${targetMonth}.json`);
      
      res.json({
        success: true,
        data: exportData
      });
    } catch (error) {
      console.error('Export error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to export calendar data'
      });
    }
  }
);

// ========== HEALTH CHECK ENDPOINTS ==========

// Calendar health check
// Access: Admin only
router.get('/health', 
  
  async (req, res) => {
    try {
      const Calendar = require('../models/Calendar');
      const Appointment = require('../models/Appointment');
      
      const today = new Date();
      const currentYear = today.getFullYear();
      const currentMonth = today.getMonth() + 1;
      
      // Check if current month calendar exists
      const currentCalendar = await Calendar.findOne({ year: currentYear, month: currentMonth });
      
      // Check for appointment-calendar inconsistencies
      const startDate = new Date(currentYear, currentMonth - 1, 1);
      const endDate = new Date(currentYear, currentMonth, 0);
      endDate.setHours(23, 59, 59, 999);
      
      const appointments = await Appointment.find({
        appointmentDate: {
          $gte: startDate,
          $lte: endDate
        },
        status: { $in: ['pending', 'confirmed', 'accepted'] }
      });
      
      let inconsistencies = [];
      
      if (currentCalendar) {
        // Check if appointments exist in calendar
        for (const appointment of appointments) {
          const appointmentDate = new Date(appointment.appointmentDate);
          const dateStr = appointmentDate.toISOString().split('T')[0];
          
          const day = currentCalendar.days.find(d => {
            const dDate = new Date(d.date);
            return dDate.toISOString().split('T')[0] === dateStr;
          });
          
          if (!day) {
            inconsistencies.push({
              type: 'MISSING_DAY',
              appointmentId: appointment._id,
              date: dateStr,
              message: 'Appointment date not found in calendar'
            });
            continue;
          }
          
          const professionalType = appointment.professionalType;
          const professionalId = appointment[`${professionalType}Id`];
          
          if (!professionalId) continue;
          
          const professional = day.professionals.find(p => 
            p.professionalId.toString() === professionalId.toString() && 
            p.professionalType === professionalType
          );
          
          if (!professional) {
            inconsistencies.push({
              type: 'MISSING_PROFESSIONAL',
              appointmentId: appointment._id,
              date: dateStr,
              professionalType,
              professionalId,
              message: 'Professional not found in calendar'
            });
          } else {
            const slotExists = professional.bookedSlots.some(slot => 
              slot.appointmentId.toString() === appointment._id.toString()
            );
            
            if (!slotExists) {
              inconsistencies.push({
                type: 'MISSING_SLOT',
                appointmentId: appointment._id,
                date: dateStr,
                professionalType,
                professionalId,
                message: 'Appointment not found in calendar booked slots'
              });
            }
          }
        }
      }
      
      res.json({
        success: true,
        health: {
          currentCalendar: !!currentCalendar,
          currentCalendarDays: currentCalendar ? currentCalendar.days.length : 0,
          currentMonthAppointments: appointments.length,
          inconsistencies: {
            count: inconsistencies.length,
            types: inconsistencies.reduce((acc, inc) => {
              acc[inc.type] = (acc[inc.type] || 0) + 1;
              return acc;
            }, {}),
            sample: inconsistencies.slice(0, 5)
          },
          status: inconsistencies.length === 0 ? 'HEALTHY' : 'NEEDS_ATTENTION',
          message: inconsistencies.length === 0 
            ? 'Calendar system is healthy' 
            : `Found ${inconsistencies.length} inconsistencies`
        }
      });
    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({
        success: false,
        error: 'Health check failed',
        details: error.message
      });
    }
  }
);

module.exports = router;