const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PUBLIC ROUTES (No authentication required) ==========

// Get doctors by specialization (public - for patient search)
router.get('/specialization/:specialization', doctorController.getDoctorsBySpecialization);

// Get doctor's availability for specific date (public - for booking)
router.get('/:id/availability', doctorController.getDoctorAvailability);

// Get doctor by ID (public - for profile viewing)
router.get('/:id', doctorController.getDoctorById);

// Get all doctors with filters (public - for patient search)
router.get('/', doctorController.getAllDoctors);

// ========== PROTECTED ROUTES (Doctor only) ==========
router.use(protect, authorize('doctor'));

// Doctor profile management
router.get('/me/profile', doctorController.getProfile);
router.put('/me/profile', doctorController.updateProfile);
router.put('/me/availability', doctorController.updateAvailability);

// Appointments
router.get('/me/appointments', doctorController.getAppointments);

// Earnings & Commission
router.get('/me/earnings', doctorController.getEarnings);
router.get('/me/earnings/report', doctorController.getDoctorEarnings);

// Dashboard
router.get('/me/dashboard', doctorController.getDoctorDashboard);

// ========== ADMIN ROUTES ==========
router.use(protect, authorize('admin'));

// Create doctor (admin only)
router.post('/', doctorController.createDoctor);

// Bulk create doctors (admin only)
router.post('/bulk', doctorController.bulkCreateDoctors);

// Update doctor by ID (admin only)
router.put('/:id', doctorController.updateDoctor);

// Delete doctor by ID (admin only)
router.delete('/:id', doctorController.deleteDoctor);

module.exports = router;