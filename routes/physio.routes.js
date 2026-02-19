// routes/physio.routes.js  (MATCHED WITH doctor.routes.js PATTERN)

const express = require('express');
const router = express.Router();

const physioController = require('../controllers/physio.controller');
const { protect, authorize } = require('../middlewares/auth');

// ========== PUBLIC ROUTES ==========
router.get('/specialization/:specialization', physioController.getPhysiosBySpecialization);
router.get('/:id/availability/weekly', physioController.getWeeklyAvailability);
router.get('/:id/availability', physioController.getPhysioAvailability);
router.get('/', physioController.getAllPhysios);
router.get('/:id', physioController.getPhysioById);

// ========== PHYSIO ROUTES ==========
router.use(protect, authorize('physio'));

router.get('/me/profile', physioController.getProfile);
router.put('/me/profile', physioController.updateProfile);
router.put('/me/availability', physioController.updateAvailability);
router.get('/me/appointments', physioController.getAppointments);
router.get('/me/earnings/report', physioController.getPhysioEarnings);
router.get('/me/earnings', physioController.getEarnings);
router.get('/me/dashboard', physioController.getPhysioDashboard);
router.post('/me/profile', physioController.createPhysiotherapist);

// optional: keep same “break” route style if you want it like calendar controller
router.post('/me/break', physioController.addBreak);

// ========== ADMIN ROUTES ==========
router.use(protect, authorize('admin'));

router.post('/bulk', physioController.bulkCreatePhysios);
router.put('/:id', physioController.updatePhysio);
router.delete('/:id', physioController.deletePhysio);

module.exports = router;
