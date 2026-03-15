// routes/physio.routes.js
const express = require('express');
const router = express.Router();

const physioController = require('../controllers/physio.controller');
const { protect, authorize } = require('../middlewares/auth');

// List / search
router.get('/', physioController.getAllPhysios);
router.get('/specialization/:specialization', physioController.getPhysiosBySpecialization);

// Availability (public)
router.get('/:id/availability/weekly', physioController.getWeeklyAvailability);
router.get('/:id/availability', physioController.getPhysioAvailability);

// ========== PHYSIO (ME) ROUTES ==========
router.use('/me', protect, authorize('physio'));

router.get('/me/profile', physioController.getProfile);
router.post('/me/profile', physioController.createPhysiotherapist);
router.put('/me/profile', physioController.updateProfile);

router.put('/me/availability', physioController.updateAvailability);
router.post('/me/break', physioController.addBreak);

router.get('/me/appointments', physioController.getAppointments);
router.get('/me/earnings', physioController.getEarnings);
router.get('/me/earnings/report', physioController.getPhysioEarnings);
router.get('/me/dashboard', physioController.getPhysioDashboard);

// ========== ADMIN ROUTES ==========
router.use(protect, authorize('admin'));

router.post('/bulk', physioController.bulkCreatePhysios);
router.put('/:id', physioController.updatePhysio);
router.delete('/:id', physioController.deletePhysio);

// ========== PUBLIC "BY ID" ROUTE MUST BE LAST ==========
router.get('/:id', physioController.getPhysioById);

module.exports = router;