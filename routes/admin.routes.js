const express = require('express');
const router = express.Router();
const adminController = require('../controllers/admin.controller');
const { protect, authorize } = require('../middlewares/auth');

router.use(protect, authorize('admin'));

router.get('/dashboard', adminController.getDashboardStats);
router.get('/professionals', adminController.getProfessionals);
router.post('/verify-professional', adminController.verifyProfessional);
router.get('/audit-logs', adminController.getAuditLogs);
router.put('/commission-settings', adminController.updateCommissionSettings);

module.exports = router;