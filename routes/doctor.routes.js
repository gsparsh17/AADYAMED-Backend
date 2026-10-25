const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PUBLIC ROUTES ==========
router.get('/meta', doctorController.getDoctorDirectoryMeta);
router.get('/me/availability', protect, authorize('doctor'), doctorController.getMyAvailability);
router.get('/specialization/:specialization', doctorController.getDoctorsBySpecialization);
router.get('/:id/availability/weekly', doctorController.getWeeklyAvailability);
router.get('/:id/availability', doctorController.getDoctorAvailability);
router.get('/', doctorController.getAllDoctors);
router.get('/:id', doctorController.getDoctorById);

// ========== ADMIN ROUTES ==========
// Declared before the doctor-only router.use() below; previously they sat after
// it and required a user to be both doctor AND admin, so they were unreachable.
router.post('/bulk', protect, authorize('admin'), doctorController.bulkCreateDoctors);
router.put('/:id', protect, authorize('admin'), doctorController.updateDoctor);
router.delete('/:id', protect, authorize('admin'), doctorController.deleteDoctor);

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
router.get('/patients/:id', doctorController.getPatientById);

module.exports = router;
