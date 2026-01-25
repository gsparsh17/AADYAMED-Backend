const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');
const { protect } = require('../middlewares/auth');

// ========== PROTECTED ROUTES ==========
router.use(protect);

// Create appointment
router.post('/', appointmentController.createAppointment);

// Get appointments (role-based)
router.get('/', appointmentController.getAppointments);

// Get appointment by ID
router.get('/:id', appointmentController.getAppointmentById);

// Update appointment status
router.put('/:id/status', appointmentController.updateAppointmentStatus);

// Cancel appointment
router.post('/:id/cancel', appointmentController.cancelAppointment);

// Reschedule appointment
router.post('/:id/reschedule', appointmentController.rescheduleAppointment);

// Complete appointment
router.post('/:id/complete', appointmentController.completeAppointment);

module.exports = router;