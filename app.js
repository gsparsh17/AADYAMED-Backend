const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const compression = require('compression');
require('dotenv').config();

const app = express();

// --- IMPORTANT: Pre-load all Mongoose models for the NEW SYSTEM ---
require('./models/User');
require('./models/DoctorProfile');
require('./models/PhysiotherapistProfile');
require('./models/PatientProfile');
require('./models/PathologyProfile');
require('./models/Referral');
require('./models/Appointment');
require('./models/Prescription');
require('./models/LabTest');
require('./models/Commission');
require('./models/CommissionSettings');
require('./models/Feedback');
require('./models/AuditLog');
require('./models/Notification');
require('./models/Calendar');
require('./models/Invoice');

// Pharmacy Models
require('./models/Medicine');
require('./models/MedicineBatch');
require('./models/Supplier');
require('./models/PurchaseOrder');
require('./models/PharmacySale');
require('./models/StockAdjustment');

// Middleware - Security
app.use(helmet()); // Set security headers
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Data sanitization against NoSQL query injection
app.use(mongoSanitize());

// Data sanitization against XSS
app.use(xss());

// Compression
app.use(compression());

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
//   message: 'Too many requests from this IP, please try again after 15 minutes'
// });
// app.use('/api');

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// --- CALENDAR SYSTEM INITIALIZATION ---
async function initializeCalendarSystem() {
  try {
    console.log('🚀 Initializing calendar system on startup...');
    
    // Import calendar jobs
    const calendarJobs = require('./jobs/calendarJob');
    
    // First, check if current month calendar exists
    const Calendar = require('./models/Calendar');
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    
    console.log(`📅 Checking current month: ${currentMonth}/${currentYear}`);
    
    const currentCalendar = await Calendar.findOne({ 
      year: currentYear, 
      month: currentMonth 
    });
    
    if (!currentCalendar) {
      console.log(`⚠️ Current month calendar not found, creating it...`);
      // Initialize current month calendar first
      await calendarJobs.initializeCalendarForMonth(currentYear, currentMonth);
    } else {
      console.log(`✅ Current month calendar already exists`);
    }
    
    // Then run full maintenance
    console.log('🔄 Running full calendar maintenance...');
    await calendarJobs.manualCalendarMaintenance();
    
    console.log('✅ Calendar system initialized successfully');
    
    // Also run inconsistency check to ensure data integrity
    setTimeout(async () => {
      try {
        await calendarJobs.fixCalendarInconsistencies();
        console.log('✅ Calendar inconsistencies checked on startup');
      } catch (error) {
        console.error('⚠️ Calendar inconsistency check failed:', error.message);
      }
    }, 5000); // Wait 5 seconds after initial setup
    
  } catch (error) {
    console.error('❌ Failed to initialize calendar system:', error.message);
    console.error('Stack:', error.stack);
    
    // Try again in 30 seconds if it fails
    console.log('🔄 Retrying calendar initialization in 30 seconds...');
    setTimeout(initializeCalendarSystem, 30000);
  }
}

// --- START CALENDAR SYSTEM AFTER MODELS ARE LOADED ---
// Use setTimeout to ensure all models are loaded before initialization
setTimeout(() => {
  initializeCalendarSystem();
}, 3000); // Wait 3 seconds for all models to load

// --- NEW ROUTES FOR AadyaPlus SYSTEM ---

// Authentication Routes
app.use('/api/auth', require('./routes/auth.routes'));

// Admin Routes
app.use('/api/admin', require('./routes/admin.routes'));

// Professional Routes
app.use('/api/doctor', require('./routes/doctor.routes'));
app.use('/api/physio', require('./routes/physio.routes'));
app.use('/api/pathology', require('./routes/pathology.routes'));

// Patient Routes
app.use('/api/patient', require('./routes/patient.routes'));

// Core Feature Routes
app.use('/api/referral', require('./routes/referral.routes'));
app.use('/api/appointment', require('./routes/appointment.routes'));
app.use('/api/prescription', require('./routes/prescription.routes'));
app.use('/api/labtest', require('./routes/labtest.routes'));

// Financial Routes
app.use('/api/commission', require('./routes/comission.routes'));
app.use('/api/invoice', require('./routes/invoice.routes'));
app.use('/api/billing', require('./routes/billing.routes'));
app.use('/api/payment', require('./routes/payment.routes'));

// Support Routes
app.use('/api/feedback', require('./routes/feedback.routes'));
app.use('/api/notifications', require('./routes/notification.routes'));
app.use('/api/calendar', require('./routes/calendar.routes'));

// Pharmacy Routes
app.use('/api/medicine', require('./routes/medicine.routes'));
app.use('/api/batch', require('./routes/batch.routes'));
app.use('/api/supplier', require('./routes/supplier.routes'));
app.use('/api/purchase-order', require('./routes/purchaseOrder.routes'));
app.use('/api/pharmacy-sale', require('./routes/pharmacySale.routes'));
app.use('/api/stock-adjustment', require('./routes/stockAdjustment.routes'));

// --- ADDITIONAL SYSTEM HEALTH ENDPOINTS ---

// Enhanced health check with system status
app.get('/health', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const Calendar = require('./models/Calendar');
    
    // Database connection status
    const dbState = mongoose.connection.readyState;
    const dbStatus = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    }[dbState] || 'unknown';
    
    // Calendar system status
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    
    const currentCalendar = await Calendar.findOne({ year: currentYear, month: currentMonth });
    
    // System uptime
    const uptime = process.uptime();
    const uptimeFormatted = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;
    
    res.status(200).json({
      status: 'success',
      message: 'AadyaPlus API is running',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      system: {
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development',
        uptime: uptimeFormatted,
        memoryUsage: process.memoryUsage()
      },
      database: {
        status: dbStatus,
        host: mongoose.connection.host,
        name: mongoose.connection.name
      },
      calendar: {
        initialized: !!currentCalendar,
        currentMonth: `${currentMonth}/${currentYear}`,
        status: currentCalendar ? 'READY' : 'NOT_INITIALIZED'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: error.message
    });
  }
});

// Calendar system status endpoint
app.get('/api/system/calendar-status', async (req, res) => {
  try {
    const calendarJobs = require('./jobs/calendarJob');
    
    // Get current calendar status
    const Calendar = require('./models/Calendar');
    const today = new Date();
    
    const calendars = await Calendar.find({})
      .sort({ year: 1, month: 1 })
      .select('year month days.date');
    
    // Calculate statistics
    const stats = {
      totalCalendars: calendars.length,
      months: calendars.map(cal => `${cal.month}/${cal.year}`),
      oldest: calendars[0] ? `${calendars[0].month}/${calendars[0].year}` : 'None',
      newest: calendars[calendars.length - 1] ? 
        `${calendars[calendars.length - 1].month}/${calendars[calendars.length - 1].year}` : 'None'
    };
    
    res.json({
      success: true,
      calendarSystem: {
        status: 'ACTIVE',
        strategy: 'Current + future months stored, past generated on-demand',
        initialization: 'Auto-initialized on server startup',
        maintenance: 'Daily cron job at 02:00 AM',
        stats
      }
    });
  } catch (error) {
    console.error('Calendar status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get calendar status'
    });
  }
});

// Manual calendar initialization endpoint (for debugging)
app.post('/api/system/initialize-calendar', async (req, res) => {
  try {
    const calendarJobs = require('./jobs/calendarJob');
    
    console.log('🚀 Manual calendar initialization triggered via API');
    
    // Run manual maintenance
    await calendarJobs.manualCalendarMaintenance();
    
    res.json({
      success: true,
      message: 'Calendar system initialized successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Manual initialization error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initialize calendar system',
      details: error.message
    });
  }
});

// API documentation endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    message: 'AadyaPlus API Documentation',
    version: '2.0.0',
    calendarSystem: {
      description: 'Smart calendar system with on-demand generation for past months',
      endpoints: {
        getCalendar: 'GET /api/calendar?year=YYYY&month=MM',
        professionalSchedule: 'GET /api/calendar/professional-schedule',
        availableSlots: 'GET /api/calendar/available-slots',
        bookSlot: 'POST /api/calendar/book-slot',
        updateAvailability: 'PUT /api/calendar/availability (Professionals only)',
        admin: {
          initialize: 'POST /api/calendar/initialize',
          cleanOld: 'POST /api/calendar/clean-old',
          manualSync: 'POST /api/calendar/manual-sync',
          fixInconsistencies: 'POST /api/calendar/fix-inconsistencies',
          systemStatus: 'GET /api/calendar/system-status',
          healthCheck: 'GET /api/calendar/health'
        }
      }
    },
    allEndpoints: {
      auth: '/api/auth',
      admin: '/api/admin',
      doctor: '/api/doctor',
      physio: '/api/physio',
      patient: '/api/patient',
      pathology: '/api/pathology',
      referral: '/api/referral',
      appointment: '/api/appointment',
      prescription: '/api/prescription',
      labtest: '/api/labtest',
      commission: '/api/commission',
      invoice: '/api/invoice',
      billing: '/api/billing',
      payment: '/api/payment',
      feedback: '/api/feedback',
      notifications: '/api/notifications',
      calendar: '/api/calendar',
      pharmacy: {
        medicine: '/api/medicine',
        batch: '/api/batch',
        supplier: '/api/supplier',
        purchase_order: '/api/purchase-order',
        pharmacy_sale: '/api/pharmacy-sale',
        stock_adjustment: '/api/stock-adjustment'
      },
      system: {
        health: '/health',
        calendarStatus: '/api/system/calendar-status',
        initializeCalendar: '/api/system/initialize-calendar (POST)'
      }
    }
  });
});

// 404 route handler
app.use((req, res, next) => {
  res.status(404).json({ 
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🚨 Global Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Something went wrong!';
  
  res.status(statusCode).json({
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV === 'development' && { 
      stack: err.stack,
      path: req.path 
    })
  });
});

module.exports = app;