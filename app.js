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
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use('/api', limiter);

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// --- NEW ROUTES FOR AADYAMED SYSTEM ---

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
app.use('/api/commission', require('./routes/commission.routes'));
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'AADYAMED API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API documentation endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    message: 'AADYAMED API Documentation',
    endpoints: {
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
      }
    }
  });
});

// Start background jobs (if any)
// const { initializeBackgroundJobs } = require('./jobs');
// initializeBackgroundJobs();

// 404 route handler
app.use((req, res, next) => {
  res.status(404).json({ 
    success: false,
    error: 'Route not found',
    path: req.originalUrl 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Something went wrong!';
  
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

module.exports = app;