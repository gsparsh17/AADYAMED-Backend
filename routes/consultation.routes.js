const express = require('express');
const router = express.Router();
const controller = require('../controllers/consultation.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.get('/history', controller.history);
router.get('/appointment/:appointmentId', controller.getByAppointment);
router.post('/appointment/:appointmentId/check-in', controller.checkIn);
router.post('/appointment/:appointmentId/start', controller.start);
router.post('/appointment/:appointmentId/join', controller.join);
router.post('/appointment/:appointmentId/leave', controller.leave);
router.patch('/appointment/:appointmentId/summary', controller.updateSummary);
router.post('/appointment/:appointmentId/end', controller.end);

module.exports = router;
