const express = require('express');
const router = express.Router();
const calendarController = require('../controllers/calendar.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

// Get calendar
router.get('/', calendarController.getCalendar);
router.get('/professional-schedule', calendarController.getProfessionalSchedule);
router.get('/available-slots', calendarController.getAvailableSlots);

// Update calendar
router.put('/availability', calendarController.updateAvailability);
router.post('/break', calendarController.addBreak);
router.post('/book-slot', calendarController.bookSlot);

module.exports = router;