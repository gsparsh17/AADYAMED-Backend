const express = require('express');
const router = express.Router();
const appointmentController = require('../controllers/appointment.controller');
const { protect } = require('../middlewares/auth');

// ========== PROTECTED ROUTES ==========
router.use(protect);

// Create appointment
router.post('/', appointmentController.createAppointment);

// Doctor/physio booking directly on a patient's behalf (Calendar, Referrals,
// PatientProfile "new appointment" flows) — auto-confirmed, no payment step.
router.post('/professional-create', appointmentController.createAppointmentByProfessional);

// Get appointments by patient id (doctor view)
router.get('/patient/:id', appointmentController.getAppointmentsByPatientId);

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