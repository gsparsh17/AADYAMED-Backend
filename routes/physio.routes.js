const express = require('express');
const router = express.Router();
const physioController = require('../controllers/physio.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('physiotherapist'));

// Profile
router.get('/profile', physioController.getProfile);
router.put('/profile', physioController.updateProfile);
router.put('/availability', physioController.updateAvailability);

// Appointments
router.get('/appointments', physioController.getAppointments);

// Earnings
router.get('/earnings', physioController.getEarnings);

// Dashboard
router.get('/dashboard', physioController.getDashboardStats);

module.exports = router;