const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notification.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.get('/', notificationController.getNotifications);
router.put('/read-all', notificationController.markAllAsRead);
router.post('/device-token', notificationController.registerDeviceToken);
// Safe to call on every app launch — the once-a-day rule is enforced server-side.
router.post('/daily-welcome', notificationController.dailyWelcome);
router.delete('/device-token', notificationController.unregisterDeviceToken);
router.put('/:id/read', notificationController.markAsRead);
router.delete('/:id', notificationController.deleteNotification);
router.post('/send', notificationController.sendNotification);

module.exports = router;
