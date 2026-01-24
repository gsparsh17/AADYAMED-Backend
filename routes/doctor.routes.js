const express = require('express');
const router = express.Router();
const doctorController = require('../controllers/doctor.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('doctor'));

router.get('/profile', doctorController.getProfile);
router.put('/profile', doctorController.updateProfile);
router.put('/availability', doctorController.updateAvailability);
router.get('/appointments', doctorController.getAppointments);
router.get('/earnings', doctorController.getEarnings);

module.exports = router;