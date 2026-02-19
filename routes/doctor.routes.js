const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PUBLIC ROUTES ==========
router.get('/specialization/:specialization', doctorController.getDoctorsBySpecialization);
router.get('/:id/availability/weekly', doctorController.getWeeklyAvailability);
router.get('/:id/availability', doctorController.getDoctorAvailability);
router.get('/', doctorController.getAllDoctors);
router.get('/:id', doctorController.getDoctorById);

// ========== DOCTOR ROUTES ==========
router.use(protect, authorize('doctor'));

router.get('/me/profile', doctorController.getProfile);
router.put('/me/profile', doctorController.updateProfile);
router.put('/me/availability', doctorController.updateAvailability);
router.get('/me/appointments', doctorController.getAppointments);
router.get('/me/earnings/report', doctorController.getDoctorEarnings);
router.get('/me/earnings', doctorController.getEarnings);
router.get('/me/dashboard', doctorController.getDoctorDashboard);
router.post('/me/profile', doctorController.createDoctor);

// ========== ADMIN ROUTES ==========
router.use(protect, authorize('admin'));

router.post('/bulk', doctorController.bulkCreateDoctors);
router.put('/:id', doctorController.updateDoctor);
router.delete('/:id', doctorController.deleteDoctor);

module.exports = router;
