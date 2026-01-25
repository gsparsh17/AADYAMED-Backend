const express = require('express');
const router = express.Router();
const physioController = require('../controllers/physio.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PROTECTED ROUTES (Physio only) ==========
router.use(protect, authorize('physio'));

// Profile Management
router.get('/profile', physioController.getProfile);
router.put('/profile', physioController.updateProfile);
router.put('/availability', physioController.updateAvailability);

// Appointments
router.get('/appointments', physioController.getAppointments);

// Earnings
router.get('/earnings', physioController.getEarnings);
router.get('/earnings/report', physioController.getEarningsReport);

// Dashboard
router.get('/dashboard', physioController.getDashboardStats);

// Add break
router.post('/break', physioController.addBreak);

module.exports = router;